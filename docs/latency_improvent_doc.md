# SOUL APP — HIERARCHICAL SYSTEM DESIGN DOCUMENTS

### WhatsApp-Style Offline-First & Optimistic UI Refactor

**Version:** 1.0 | **Stack:** React Native 0.84.1 · expo-sqlite (WAL) · Supabase · Cloudflare R2  
**For:** Autonomous AI Coding Agent (Human-in-the-Loop)

---

## TABLE OF CONTENTS

1. [Master Goal & Architecture Vision](#1-master-goal--architecture-vision)
2. [Research & Algorithmic Rethink Phase](#2-research--algorithmic-rethink-phase)
3. [Task & Subtask Hierarchy](#3-task--subtask-hierarchy)
4. [Human-in-the-Loop Testing Protocols](#4-human-in-the-loop-testing-protocols)
5. [Appendix: Schema Reference & File Map](#5-appendix-schema-reference--file-map)

---

## 1. MASTER GOAL & ARCHITECTURE VISION

### 1.1 The North Star

Transform Soul from a "server-first app with offline fallbacks" into a **SQLite-first app that occasionally syncs to the cloud**. The local database is the _only_ source of truth the UI ever reads from. The network is just a background sync mechanism — its failure must be invisible to the user.

### 1.2 The Golden Rule (enforced at every phase)

```
USER ACTION → SQLite (immediate) → UI reflects change (0ms latency)
                                 ↓
                         pending_sync_ops queue
                                 ↓
                    SyncWorker (background, retryable)
                                 ↓
                    Supabase / Cloudflare R2
                                 ↓
                    SQLite update (confirmation)
                                 ↓
                         UI reflects final state
```

**The UI must NEVER await a network call.** It only listens to SQLite.

### 1.3 Architecture Layers (Post-Refactor)

```
┌─────────────────────────────────────────────────┐
│                   UI LAYER                      │
│  SingleChatScreen · StatusScreen · SoulAvatar   │
│  ONLY reads from SQLite via live-query hooks    │
└────────────────────────┬────────────────────────┘
                         │ useLiveQuery()
┌────────────────────────▼────────────────────────┐
│              LOCAL DATABASE LAYER               │
│  expo-sqlite (WAL mode)                         │
│  messages · chats · contacts · pending_sync_ops │
│  media_downloads · statuses · avatars           │
└──────────┬─────────────────────────┬────────────┘
           │ INSERT (optimistic)     │ SELECT (live)
┌──────────▼──────────┐   ┌─────────▼────────────┐
│  LocalDBService.ts  │   │  useSQLiteLiveQuery  │
│  (write-only API)   │   │  (read-only hooks)   │
└──────────┬──────────┘   └──────────────────────┘
           │ enqueues to pending_sync_ops
┌──────────▼──────────────────────────────────────┐
│              SYNC ENGINE LAYER                  │
│  SyncWorker.ts (BackgroundSyncService)          │
│  • Exponential backoff                          │
│  • Idempotency key deduplication                │
│  • Payload merging (last-write wins)            │
│  • Network-aware scheduling (NetInfo)           │
└──────────┬──────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────┐
│             EXTERNAL SERVICES LAYER             │
│  Supabase Postgres · Realtime WS · Cloudflare R2│
└─────────────────────────────────────────────────┘
```

### 1.4 Guiding Constraints for the Coding Agent

- **Never break compilation** between phases. Each phase must leave the app in a runnable state.
- **Feature flags** via a `FEATURES` constant object — new code paths are gated and can be toggled.
- **One file edited per subtask** where possible; batch only when interfaces must change together.
- **No RAM expansion** — Base64 is banned app-wide after Phase 2.
- **Idempotency everywhere** — every sync op carries an `idempotency_key` (UUIDv4) generated at write time.

---

## 2. RESEARCH & ALGORITHMIC RETHINK PHASE

> This section challenges the proposed solutions and defines the finalized algorithms before any code is written.

### 2.1 The Sync Engine — Challenges & Final Algorithm

**Challenge:** A naive FIFO queue with linear backoff will hammer the server on reconnect and block later messages behind a stuck upload.

**Finalized Algorithm: Typed Priority Queue with Exponential Backoff**

```
Priority tiers (processed in order within each flush cycle):
  P0 — read_receipts, delivered_acks       (tiny payloads, user-visible)
  P1 — text_messages                       (no blob, must be fast)
  P2 — profile_updates, status_metadata   (mergeable, low urgency)
  P3 — media_uploads                       (large, chunked, resumable)

Backoff formula:
  delay = min(BASE_DELAY * 2^retry_count, MAX_DELAY) + jitter
  BASE_DELAY = 2000ms
  MAX_DELAY  = 300000ms (5 min)
  jitter     = random(0, 1000)ms   ← prevents thundering herd on reconnect

Max retries per op:
  P0/P1 = 10 retries, then mark as 'failed' and surface error in UI
  P2    = 20 retries (profile sync can wait)
  P3    = resume-aware; no retry limit until file is gone from disk
```

**Payload Merging (Deduplication):**

```
For op_type = 'profile_update' OR 'status_update':
  Before inserting a new row into pending_sync_ops:
    SELECT id FROM pending_sync_ops
    WHERE entity_type = ? AND entity_id = ? AND op_type = ?
    AND status = 'pending'
  If found → UPDATE that row's payload (last-write wins), bump updated_at
  If not found → INSERT new row

For op_type = 'send_message':
  NEVER merge. Each message has a unique idempotency_key. Always INSERT.

For op_type = 'read_receipt':
  Merge per chat_id: collapse N receipts into one batch payload.
```

### 2.2 Race Condition — Duplicate Message Bubble Problem

**The Problem:**

1. User sends message → local UUID `msg_local_123` written to SQLite, UI renders it.
2. SyncWorker uploads to Supabase → Supabase assigns server UUID `msg_server_456`.
3. Supabase Realtime WebSocket fires `INSERT` event with `msg_server_456`.
4. ChatService receives the event and inserts `msg_server_456` into SQLite.
5. **Result:** Two bubbles — `msg_local_123` (pending) and `msg_server_456` (sent).

**Finalized Solution: Idempotency Key as the Canonical Identity**

```
Step 1 (at send time):
  Generate idempotency_key = UUIDv4()
  Write to SQLite: { id: idempotency_key, status: 'pending', ... }
  Add to pending_sync_ops payload: { idempotency_key: idempotency_key }

Step 2 (Supabase schema):
  messages table must have: idempotency_key VARCHAR UNIQUE

Step 3 (SyncWorker after successful upload):
  UPDATE messages SET id = server_uuid, status = 'sent'
  WHERE id = idempotency_key
  (SQLite supports updating the PK if foreign keys are deferred)

  Alternative (safer): Keep local UUID as primary key in SQLite forever.
  Add a separate column: server_id UUID NULL
  When server confirms: UPDATE messages SET server_id = ?, status = 'sent'
  WHERE idempotency_key = ?

Step 4 (ChatService on Realtime event):
  On receiving a new message from Realtime:
    const existing = await db.getFirstAsync(
      'SELECT id FROM messages WHERE idempotency_key = ?',
      [incomingMsg.idempotency_key]
    )
    if (existing) {
      // It's our own message reflected back — just update server_id & status
      UPDATE messages SET server_id = ?, status = 'sent'
      WHERE idempotency_key = ?
      RETURN  ← do NOT insert new row
    }
    // It's a message from the other person — insert normally
    INSERT INTO messages ...
```

**Decision:** Use `server_id` as a nullable column. Local UUID (`id`) is the permanent SQLite PK. This avoids cascading FK updates.

### 2.3 Garbage Collection Strategy

**Challenge:** If every video/avatar is saved to `Soul/Media/`, 30 days of usage on a 1GB media chat will exhaust storage.

**Finalized GC Algorithm:**

```
GC runs:
  - On app foreground (if last GC > 24 hours ago)
  - When device storage < 500MB free (check via expo-file-system.getFreeDiskStorageAsync)

Media GC Rules (Soul/Media/):
  Phase A — Immediate candidates:
    SELECT local_file_uri FROM messages
    WHERE status = 'sent'                    ← upload confirmed
    AND media_url IS NOT NULL               ← remote copy exists
    AND starred = 0                          ← not starred by user
    AND created_at < NOW() - INTERVAL 30 DAYS

  Phase B — Storage pressure (< 200MB free):
    Reduce threshold to 7 days for non-starred media

  Phase C — Nuclear (< 50MB free):
    Delete ALL non-starred sent media. Keep only local_file_uri for
    messages in the last 24h (user is likely viewing them).

  Action:
    expo-file-system.deleteAsync(local_file_uri, { idempotent: true })
    UPDATE messages SET local_file_uri = NULL WHERE id = ?
    (UI falls back to media_url remote fetch when local_file_uri is NULL)

Avatar GC Rules (Soul/Avatars/):
  Keep only avatars for contacts with last_seen > 60 days ago
  DELETE Soul/Avatars/{contact_id}.jpg for stale contacts
  UPDATE contacts SET avatar = remote_url WHERE id = ?

Schema addition needed:
  messages: ADD COLUMN starred INTEGER DEFAULT 0
  messages: ADD COLUMN gc_protected INTEGER DEFAULT 0  ← manual pin
```

### 2.4 Storage Permission Failure Resilience

**Challenge:** If the user denies storage permissions, `expo-file-system` operations throw. The app must not crash and must gracefully degrade.

**Finalized Resilience Strategy:**

```
Layer 1 — Permission check at startup (AppInitService.ts):
  const perms = await MediaLibrary.requestPermissionsAsync()
  Store result in a module-level flag: STORAGE_AVAILABLE = perms.granted
  Expose via useStoragePermission() hook

Layer 2 — FileSystemService.ts wrapper (new file):
  async function safeCopy(src, dest): Promise<string | null> {
    if (!STORAGE_AVAILABLE) return null
    try {
      await FileSystem.copyAsync({ from: src, to: dest })
      return dest
    } catch (e) {
      captureError(e)  ← log to Sentry/Crashlytics
      return null      ← caller handles null gracefully
    }
  }

Layer 3 — Message send flow:
  const localUri = await safeCopy(pickedFileUri, permanentPath)
  if (localUri) {
    // Normal path: save URI to SQLite, render locally, upload in bg
    await LocalDBService.insertMessage({ ..., local_file_uri: localUri })
  } else {
    // Fallback path: upload directly (blocking), save remote URL
    // Show "Uploading..." overlay — this is the degraded experience
    await LocalDBService.insertMessage({ ..., status: 'uploading' })
    SyncWorker.prioritize(messageId)  ← push to front of queue
  }

Layer 4 — Permission re-request banner:
  If STORAGE_AVAILABLE = false, show a dismissable banner in SingleChatScreen:
  "Soul needs storage access for offline media. Tap to enable."
```

### 2.5 Re-evaluated: Typing Indicators

**Original proposal:** Use Supabase Presence only.

**Confirmed correct.** Typing state is ephemeral and must NEVER touch SQLite or `pending_sync_ops`. The existing `channel.track({ typing: true })` pattern is correct. The only fix needed is proper cleanup — call `channel.track({ typing: false })` on blur and on component unmount. No database involvement whatsoever.

### 2.6 Re-evaluated: Status Uploads (Stories)

**Original proposal:** Write to SQLite `statuses` table, then sync via BackgroundSyncService.

**Architectural refinement:** The current schema has no `statuses` table. We must add it in Phase 1 (schema migration). Status media follows the same pipeline as message media (local file → R2 upload via SyncWorker). The `status` field mirrors message status: `'pending' → 'uploading' → 'sent' → 'viewed'`.

---

## 3. TASK & SUBTASK HIERARCHY

> Phases are strictly ordered. Each phase is compilable and testable independently. The coding agent must complete all subtasks in a phase before moving to the next.

---

### ═══ PHASE 0: PREPARATION ═══

**Goal:** Set up scaffolding, feature flags, and helpers without touching any existing logic.  
**Risk:** Zero — purely additive.

---

#### Task 0.1 — Feature Flag System

**File:** `mobile/constants/Features.ts` _(new file)_

```typescript
// Create this file. All new code paths are gated by these flags.
export const FEATURES = {
  OFFLINE_FIRST_CHAT: false, // Phase 3
  LOCAL_MEDIA_PIPELINE: false, // Phase 2
  AVATAR_CACHE: false, // Phase 4
  SYNC_ENGINE_V2: false, // Phase 1
  STATUS_OFFLINE: false, // Phase 5
} as const;
```

**Verification:** TypeScript compiles. No runtime changes.

---

#### Task 0.2 — Error Tracking Stub

**File:** `mobile/services/ErrorService.ts` _(new file)_

```typescript
// Wraps Sentry or console.error. All try/catch blocks use this.
export function captureError(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  // TODO: Replace console.error with Sentry.captureException in production
  console.error("[Soul Error]", error, context);
}
```

---

#### Task 0.3 — FileSystemService Wrapper

**File:** `mobile/services/FileSystemService.ts` _(new file)_

Subtasks:

1. Create `SOUL_MEDIA_DIR` = `FileSystem.documentDirectory + 'Soul/Media/'`
2. Create `SOUL_AVATAR_DIR` = `FileSystem.documentDirectory + 'Soul/Avatars/'`
3. Implement `ensureDirectories()` — creates dirs if missing, handles permission error.
4. Implement `safeCopy(src, dest): Promise<string | null>` — as defined in §2.4.
5. Implement `safeDelete(uri): Promise<boolean>`.
6. Implement `getFreeDiskSpaceBytes(): Promise<number>`.

**Verification:** Unit test `safeCopy` with a dummy file. Verify `null` returned when source doesn't exist.

---

#### Task 0.4 — DB Migration Helper

**File:** `mobile/database/migrations.ts` _(new file)_

```typescript
// Versioned migration runner. Schema changes go here, never in schema.ts directly.
export const MIGRATIONS: Array<{ version: number; sql: string }> = [];

export async function runMigrations(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS __migrations (version INTEGER PRIMARY KEY)`,
  );
  // ... run pending migrations in order
}
```

**Verification:** App opens. `__migrations` table created in SQLite.

---

### ═══ PHASE 1: SQLITE SCHEMA UPDATES ═══

**Goal:** Add all new columns and tables needed by later phases. Migrations must be backward-compatible (use `ALTER TABLE ADD COLUMN IF NOT EXISTS` pattern).  
**Risk:** Low — additive schema changes only.

---

#### Task 1.1 — Add `server_id` and `starred` to `messages`

**File:** `mobile/database/migrations.ts`

Migration SQL:

```sql
ALTER TABLE messages ADD COLUMN server_id TEXT;
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN gc_protected INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_messages_idempotency ON messages(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_messages_server_id ON messages(server_id);
```

**Why `server_id` nullable:** As decided in §2.2, local UUID is the permanent PK. `server_id` is filled after Supabase confirms delivery.

---

#### Task 1.2 — Add priority and status to `pending_sync_ops`

**File:** `mobile/database/migrations.ts`

Migration SQL:

```sql
ALTER TABLE pending_sync_ops ADD COLUMN priority INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pending_sync_ops ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE pending_sync_ops ADD COLUMN last_attempted_at INTEGER;
ALTER TABLE pending_sync_ops ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_sync_ops_priority ON pending_sync_ops(priority, next_attempt_at, status);
```

Priority values: `0=P0, 1=P1, 2=P2, 3=P3` as defined in §2.1.

---

#### Task 1.3 — Create `statuses` table

**File:** `mobile/database/migrations.ts`

Migration SQL:

```sql
CREATE TABLE IF NOT EXISTS statuses (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  media_type TEXT,
  local_file_uri TEXT,
  media_url TEXT,
  caption TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  server_id TEXT,
  idempotency_key TEXT UNIQUE NOT NULL
);
```

---

#### Task 1.4 — Add `local_avatar_uri` to `contacts`

**File:** `mobile/database/migrations.ts`

Migration SQL:

```sql
ALTER TABLE contacts ADD COLUMN local_avatar_uri TEXT;
```

**Logic:** `SoulAvatar.tsx` will prefer `local_avatar_uri` over `avatar` (remote URL).

---

#### Task 1.5 — Wire migrations into app startup

**File:** `mobile/database/index.ts` (or wherever `db` is initialized)

Call `runMigrations(db)` before any other DB operation at app start. Verify with `console.log('[DB] Migrations complete')`.

**Human checkpoint:** Open app. Check console for migration log. Open DB Browser for SQLite and confirm new columns exist. App should look identical to before.

---

### ═══ PHASE 2: LOCAL MEDIA PIPELINE ═══

**Goal:** Eliminate Base64 from `SingleChatScreen.tsx`. All media writes to local disk first.  
**Risk:** Medium — touches file I/O and camera/gallery picker.  
**Feature flag:** `FEATURES.LOCAL_MEDIA_PIPELINE`

---

#### Task 2.1 — Media Picker Refactor

**File:** `mobile/screens/SingleChatScreen.tsx`

Find: All `FileReader` / `ev.target.result` / `.readAsDataURL` usage.

Replace with:

```typescript
// OLD (crashes on large videos):
const reader = new FileReader();
reader.onload = (ev) => {
  const base64 = ev.target.result;
};
reader.readAsDataURL(file);

// NEW (zero RAM overhead):
import * as FileSystem from "expo-file-system";
import { safeCopy } from "../services/FileSystemService";
import { generateMediaFileName } from "../utils/mediaUtils";

const permanentUri = SOUL_MEDIA_DIR + generateMediaFileName(asset.mimeType);
const localUri = await safeCopy(asset.uri, permanentUri);
if (!localUri) {
  // Storage permission denied — show toast and use direct upload fallback
  return;
}
// localUri is now the permanent path used everywhere downstream
```

Subtasks:

1. Remove all `FileReader` imports and usages.
2. Remove all `base64` state variables related to media.
3. `generateMediaFileName(mimeType)` → `${Date.now()}_${uuid()}.${ext}` utility in `mobile/utils/mediaUtils.ts`.
4. After picking, call `LocalDBService.insertMessage({ local_file_uri: localUri, status: 'pending' })`.
5. Do NOT upload in this function. Enqueue to `pending_sync_ops` with `priority: 3`.

---

#### Task 2.2 — Media Upload Worker

**File:** `mobile/services/MediaUploadWorker.ts` _(new file)_

Implements streaming upload to Cloudflare R2. **No Base64.** Uses `fetch` with `body: blob` pattern.

```typescript
export async function uploadMediaToR2(
  localUri: string,
  mimeType: string,
  onProgress: (progress: number) => void,
): Promise<string> {
  // returns remote URL
  const fileInfo = await FileSystem.getInfoAsync(localUri);
  if (!fileInfo.exists) throw new Error("Local file missing: " + localUri);

  // Use XMLHttpRequest for upload progress (fetch doesn't support onprogress in RN)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status === 200) resolve(JSON.parse(xhr.responseText).url);
      else reject(new Error("R2 upload failed: " + xhr.status));
    };
    xhr.onerror = reject;
    // NOTE: Replace localhost:3000 with your actual R2 upload endpoint
    xhr.open("POST", process.env.EXPO_PUBLIC_R2_UPLOAD_URL);
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.send({
      uri: localUri,
      type: mimeType,
      name: localUri.split("/").pop(),
    });
  });
}
```

> ⚠️ **HUMAN CHECKPOINT:** Replace `localhost:3000` / `EXPO_PUBLIC_R2_UPLOAD_URL` with the actual Cloudflare R2 presigned URL endpoint. Verify upload works on a physical device before proceeding.

---

#### Task 2.3 — Remove `onUploadProgressCb` direct assignment bug

**File:** `mobile/services/ChatService.ts`

Find the pattern where `onUploadProgressCb` is assigned as a module-level variable (known bug from existing code). Replace with a proper event emitter or callback passed via `SyncWorker.enqueue(op, { onProgress })`.

This eliminates the race condition where progress callbacks fire on wrong message instances.

---

#### Task 2.4 — UI: Render local URI first

**File:** `mobile/components/MessageBubble.tsx` (or equivalent)

Priority order for image/video source:

```typescript
const mediaSource = message.local_file_uri ?? message.media_url ?? null;

// If local_file_uri exists → render instantly with no network
// If only media_url → render from remote (online only)
// If neither → show placeholder
```

---

### ═══ PHASE 3: DECOUPLE UI FROM CONTEXT & SUPABASE ═══

**Goal:** `SingleChatScreen.tsx` reads messages ONLY from SQLite via a live query hook. Zero Supabase reads in the UI layer.  
**Risk:** High — core screen refactor. Must be gated behind `FEATURES.OFFLINE_FIRST_CHAT`.

---

#### Task 3.1 — Create `useLiveMessages` hook

**File:** `mobile/hooks/useLiveMessages.ts` _(new file)_

```typescript
import { useSQLiteContext } from "expo-sqlite";

export function useLiveMessages(chatId: string, limit = 50) {
  const db = useSQLiteContext();
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    // expo-sqlite useLiveQuery pattern
    const statement = db.prepareSync(
      `SELECT * FROM messages
       WHERE chat_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    );
    // Set up polling or expo-sqlite onChange subscription
    // expo-sqlite v14+ supports addListener for table changes
    const subscription = db.addUpdateListener(() => {
      const rows = statement.executeSync([chatId, limit]);
      setMessages(rows.getAllSync());
    });
    // Initial load
    const rows = statement.executeSync([chatId, limit]);
    setMessages(rows.getAllSync());

    return () => {
      subscription.remove();
      statement.finalizeSync();
    };
  }, [chatId]);

  return messages;
}
```

---

#### Task 3.2 — Remove `useApp()` message arrays from `SingleChatScreen`

**File:** `mobile/screens/SingleChatScreen.tsx`

Subtasks:

1. Remove: `const { messages, setMessages } = useApp()`
2. Add: `const messages = useLiveMessages(chatId)`
3. Remove all `setMessages([...])` calls — state is now driven by SQLite writes.
4. Remove all `supabase.from('messages').select(...)` calls in this file.
5. Verify: Screen renders correctly with data from SQLite only.

---

#### Task 3.3 — Create `LocalDBService.insertMessage()`

**File:** `mobile/services/LocalDBService.ts`

Add a clean typed API:

```typescript
export async function insertMessage(msg: Partial<Message> & { id: string; chat_id: string; idempotency_key: string }): Promise<void> {
  await db.runAsync(
    `INSERT OR IGNORE INTO messages
     (id, chat_id, sender, receiver, text, status, local_file_uri, media_url,
      media_type, is_unsent, retry_count, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.chat_id, ...]
  )
  // Also update chats.last_message_preview and chats.last_message_at
  await db.runAsync(
    `UPDATE chats SET last_message_preview = ?, last_message_at = ?, updated_at = ?
     WHERE id = ?`,
    [msg.text ?? '[Media]', Date.now(), Date.now(), msg.chat_id]
  )
}
```

---

#### Task 3.4 — Move send logic to `LocalDBService` + `SyncWorker`

**File:** `mobile/screens/SingleChatScreen.tsx`

The send button handler must do only two things:

```typescript
async function handleSend(text: string) {
  const idempotencyKey = uuid();
  const localId = uuid(); // permanent SQLite PK

  // 1. Write to SQLite immediately (optimistic)
  await LocalDBService.insertMessage({
    id: localId,
    idempotency_key: idempotencyKey,
    chat_id: chatId,
    sender: currentUser.id,
    receiver: recipientId,
    text,
    status: "pending",
    created_at: Date.now(),
  });

  // 2. Enqueue sync op (non-blocking)
  await LocalDBService.enqueueSyncOp({
    entity_type: "message",
    entity_id: localId,
    op_type: "send_message",
    payload: JSON.stringify({
      idempotency_key: idempotencyKey,
      text,
      chat_id: chatId,
    }),
    priority: 1, // P1 — text message
  });
  // UI already updated via useLiveMessages — no setState needed
}
```

---

#### Task 3.5 — `ChatService` Realtime: Write to SQLite, not state

**File:** `mobile/services/ChatService.ts`

The Realtime subscription handler must:

1. On `INSERT` event from Supabase:
   - Check for existing `idempotency_key` in SQLite (§2.2 dedup logic).
   - If found: update `server_id` and `status`. Return.
   - If not found: call `LocalDBService.insertMessage(incomingMsg)`.
2. On `UPDATE` event (e.g., status changes from server):
   - `UPDATE messages SET status = ? WHERE server_id = ?`
3. Remove all state mutation (`setMessages`, context updates) from this service.

---

#### Task 3.6 — Fix infinite loop bugs

**File:** `mobile/services/ChatService.ts`

These are the two confirmed infinite loops from prior work:

**Loop 1 — WebSocket reconnect loop:**

```typescript
// ADD a reconnect guard:
let isReconnecting = false;
let reconnectTimer: NodeJS.Timeout | null = null;

function scheduleReconnect(delay: number) {
  if (isReconnecting) return; // ← GUARD
  isReconnecting = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    isReconnecting = false;
    connectRealtime();
  }, delay);
}
```

**Loop 2 — `processQueue()` loop:**

```typescript
// ADD a processing guard:
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue) return; // ← GUARD
  isProcessingQueue = true;
  try {
    await doProcessQueue();
  } finally {
    isProcessingQueue = false;
    // Reschedule only if there are remaining ops
    const pending = await getPendingOpsCount();
    if (pending > 0) scheduleProcessQueue();
  }
}
```

---

### ═══ PHASE 4: AVATAR CACHING ═══

**Goal:** `SoulAvatar.tsx` always renders from local disk. Remote URLs are only fetched once and cached permanently (until contact goes stale).  
**Risk:** Low — isolated to avatar rendering.  
**Feature flag:** `FEATURES.AVATAR_CACHE`

---

#### Task 4.1 — `AvatarCacheService.ts` _(new file)_

**File:** `mobile/services/AvatarCacheService.ts`

```typescript
export async function ensureAvatarCached(
  contactId: string,
  remoteUrl: string,
): Promise<string> {
  // 1. Check SQLite: does contacts.local_avatar_uri exist?
  const contact = await LocalDBService.getContact(contactId);
  if (contact?.local_avatar_uri) {
    const info = await FileSystem.getInfoAsync(contact.local_avatar_uri);
    if (info.exists) return contact.local_avatar_uri; // ← serve from disk
  }

  // 2. Download to Soul/Avatars/{contactId}.jpg
  const localPath = SOUL_AVATAR_DIR + contactId + ".jpg";
  await FileSystem.downloadAsync(remoteUrl, localPath);

  // 3. Update contacts.local_avatar_uri in SQLite
  await LocalDBService.updateContactAvatar(contactId, localPath);

  return localPath;
}
```

---

#### Task 4.2 — Refactor `SoulAvatar.tsx`

**File:** `mobile/components/SoulAvatar.tsx`

```typescript
function SoulAvatar({ contactId, remoteUrl, size }) {
  const [uri, setUri] = useState<string | null>(null)

  useEffect(() => {
    if (!FEATURES.AVATAR_CACHE) {
      setUri(remoteUrl)
      return
    }
    AvatarCacheService.ensureAvatarCached(contactId, remoteUrl)
      .then(setUri)
      .catch(() => setUri(remoteUrl))  // Fallback to remote on error
  }, [contactId, remoteUrl])

  return (
    <Image
      source={uri ? { uri } : require('../assets/default_avatar.png')}
      style={{ width: size, height: size, borderRadius: size / 2 }}
    />
  )
}
```

---

#### Task 4.3 — Background Avatar Pre-fetch

**File:** `mobile/services/BackgroundSyncService.ts`

In the background fetch handler, after processing `pending_sync_ops`, run:

```typescript
async function preFetchAllAvatars() {
  const contacts = await LocalDBService.getAllContacts();
  for (const contact of contacts) {
    if (contact.avatar && !contact.local_avatar_uri) {
      await AvatarCacheService.ensureAvatarCached(
        contact.id,
        contact.avatar,
      ).catch(captureError);
    }
  }
}
```

---

### ═══ PHASE 5: SYNC ENGINE V2 ═══

**Goal:** Replace `BackgroundSyncService`'s naive queue processing with the priority + exponential backoff engine defined in §2.1.  
**Risk:** Medium — must handle concurrent uploads, network drops, and server errors gracefully.  
**Feature flag:** `FEATURES.SYNC_ENGINE_V2`

---

#### Task 5.1 — `SyncWorker.ts` _(new file — replaces inline logic)_

**File:** `mobile/services/SyncWorker.ts`

Implement the full Typed Priority Queue engine:

```typescript
const BACKOFF_CONFIG = {
  BASE_DELAY: 2000,
  MAX_DELAY: 300_000,
  MAX_RETRIES: { P0: 10, P1: 10, P2: 20, P3: Infinity },
};

function calculateNextAttempt(retryCount: number): number {
  const delay =
    Math.min(
      BACKOFF_CONFIG.BASE_DELAY * Math.pow(2, retryCount),
      BACKOFF_CONFIG.MAX_DELAY,
    ) +
    Math.random() * 1000; // jitter
  return Date.now() + delay;
}

export async function flushQueue(): Promise<void> {
  if (isProcessingQueue) return;

  const ops = await db.getAllAsync<SyncOp>(
    `SELECT * FROM pending_sync_ops
     WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY priority ASC, created_at ASC
     LIMIT 20`,
    [Date.now()],
  );

  for (const op of ops) {
    await processOp(op);
  }
}

async function processOp(op: SyncOp): Promise<void> {
  try {
    await db.runAsync(
      `UPDATE pending_sync_ops SET status = 'processing', last_attempted_at = ? WHERE id = ?`,
      [Date.now(), op.id],
    );

    await dispatchOp(op); // Routes to correct handler by op_type

    await db.runAsync(
      `UPDATE pending_sync_ops SET status = 'done' WHERE id = ?`,
      [op.id],
    );
  } catch (e) {
    const newRetryCount = op.retry_count + 1;
    const maxRetries = BACKOFF_CONFIG.MAX_RETRIES[`P${op.priority}`] ?? 10;

    if (newRetryCount >= maxRetries) {
      await db.runAsync(
        `UPDATE pending_sync_ops SET status = 'failed', retry_count = ? WHERE id = ?`,
        [newRetryCount, op.id],
      );
      // Surface error to UI: update message status to 'failed'
      await LocalDBService.updateMessageStatus(op.entity_id, "failed");
      return;
    }

    await db.runAsync(
      `UPDATE pending_sync_ops
       SET status = 'pending', retry_count = ?, next_attempt_at = ?
       WHERE id = ?`,
      [newRetryCount, calculateNextAttempt(newRetryCount), op.id],
    );
  }
}
```

---

#### Task 5.2 — `dispatchOp()` router

**File:** `mobile/services/SyncWorker.ts`

```typescript
async function dispatchOp(op: SyncOp): Promise<void> {
  const payload = JSON.parse(op.payload);

  switch (op.op_type) {
    case "send_message":
      return await syncSendMessage(op, payload);
    case "read_receipt":
      return await syncReadReceipt(op, payload);
    case "delivered_ack":
      return await syncDeliveredAck(op, payload);
    case "media_upload":
      return await syncMediaUpload(op, payload);
    case "profile_update":
      return await syncProfileUpdate(op, payload);
    case "status_upload":
      return await syncStatusUpload(op, payload);
    default:
      throw new Error("Unknown op_type: " + op.op_type);
  }
}
```

---

#### Task 5.3 — Read Receipts via SyncWorker

**File:** `mobile/services/ChatService.ts`

Find `markMessagesAsRead()`. Replace the direct Supabase call:

```typescript
// OLD (data loss if offline):
await supabase.from("message_reads").insert({ message_id, user_id, read_at });

// NEW (queued, never lost):
await LocalDBService.enqueueSyncOp({
  entity_type: "message",
  entity_id: messageId,
  op_type: "read_receipt",
  payload: JSON.stringify({
    message_id: messageId,
    chat_id: chatId,
    read_at: Date.now(),
  }),
  priority: 0, // P0 — highest priority
});
```

---

#### Task 5.4 — Payload Merging for Profile Updates

**File:** `mobile/services/LocalDBService.ts`

Implement `enqueueOrMergeSyncOp()`:

```typescript
export async function enqueueOrMergeSyncOp(
  op: Omit<SyncOp, "id" | "created_at" | "retry_count">,
): Promise<void> {
  const MERGEABLE_OPS = ["profile_update", "status_update"];

  if (MERGEABLE_OPS.includes(op.op_type)) {
    const existing = await db.getFirstAsync<{ id: number }>(
      `SELECT id FROM pending_sync_ops
       WHERE entity_type = ? AND entity_id = ? AND op_type = ? AND status = 'pending'`,
      [op.entity_type, op.entity_id, op.op_type],
    );
    if (existing) {
      await db.runAsync(
        `UPDATE pending_sync_ops SET payload = ?, created_at = ? WHERE id = ?`,
        [op.payload, Date.now(), existing.id],
      );
      return;
    }
  }

  await db.runAsync(
    `INSERT INTO pending_sync_ops (entity_type, entity_id, op_type, payload, priority, created_at, retry_count, status, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', 0)`,
    [
      op.entity_type,
      op.entity_id,
      op.op_type,
      op.payload,
      op.priority,
      Date.now(),
    ],
  );
}
```

---

#### Task 5.5 — Network-Aware Queue Flush Trigger

**File:** `mobile/services/SyncWorker.ts`

```typescript
import NetInfo from "@react-native-community/netinfo";
import { AppState } from "react-native";

export function startSyncWorker() {
  // Flush on network reconnect
  NetInfo.addEventListener((state) => {
    if (state.isConnected && state.isInternetReachable) {
      flushQueue();
    }
  });

  // Flush on app foreground
  AppState.addEventListener("change", (nextState) => {
    if (nextState === "active") {
      flushQueue();
    }
  });

  // Periodic flush every 30s (catches missed events)
  setInterval(flushQueue, 30_000);
}
```

---

### ═══ PHASE 6: OFFLINE STATUS SERVICE ═══

**Goal:** `StatusService.ts` never calls Supabase directly.  
**Risk:** Low — isolated service.  
**Feature flag:** `FEATURES.STATUS_OFFLINE`

---

#### Task 6.1 — Rewrite `StatusService.ts`

**File:** `mobile/services/StatusService.ts`

```typescript
// OLD pattern (blocks UI, data loss if offline):
async function postStatus(mediaUri, caption) {
  await supabase.storage.from('statuses').upload(...)
  await supabase.from('statuses').insert(...)
}

// NEW pattern (instant optimistic write):
async function postStatus(mediaUri, caption, mimeType) {
  const idempotencyKey = uuid()
  const localId = uuid()
  const permanentUri = SOUL_MEDIA_DIR + generateMediaFileName(mimeType)
  const localUri = await safeCopy(mediaUri, permanentUri)

  // 1. Write to statuses SQLite table
  await db.runAsync(
    `INSERT INTO statuses (id, sender_id, local_file_uri, caption, status, expires_at, created_at, idempotency_key)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [localId, currentUser.id, localUri, caption, Date.now() + 86400000, Date.now(), idempotencyKey]
  )

  // 2. Enqueue media upload (P3) + metadata sync (P2)
  await LocalDBService.enqueueSyncOp({
    entity_type: 'status', entity_id: localId,
    op_type: 'status_upload',
    payload: JSON.stringify({ local_uri: localUri, caption, idempotency_key: idempotencyKey, mime_type: mimeType }),
    priority: 3,
  })
}
```

---

### ═══ PHASE 7: GARBAGE COLLECTION ═══

**Goal:** Implement the GC algorithm from §2.3 to prevent storage exhaustion.  
**Risk:** Low — runs in background, never deletes actively-referenced files.

---

#### Task 7.1 — `GarbageCollectionService.ts` _(new file)_

**File:** `mobile/services/GarbageCollectionService.ts`

Implement the three-phase GC algorithm exactly as defined in §2.3:

1. `runMediaGC()` — Phase A (30 days), Phase B (7 days if < 200MB), Phase C (nuclear if < 50MB).
2. `runAvatarGC()` — delete avatars for contacts with `last_seen` > 60 days.
3. `shouldRunGC()` — returns true if last GC > 24h ago OR free space < 500MB.
4. Export `maybeRunGC()` — calls `shouldRunGC()` then runs both GC functions.

---

#### Task 7.2 — Trigger GC on app foreground

**File:** `mobile/services/SyncWorker.ts`

In the `AppState` change handler:

```typescript
if (nextState === "active") {
  flushQueue();
  GarbageCollectionService.maybeRunGC(); // ← add this
}
```

---

### ═══ PHASE 8: PROFILE & NOTES OFFLINE ═══

**Goal:** Profile writes go to SQLite first, sync later.  
**Risk:** Very low — simple queue pattern already established.

---

#### Task 8.1 — Find and fix `postNote` direct Supabase call

**File:** `mobile/services/` (whichever file contains `postNote`)

```typescript
// Replace:
await supabase.from("profiles").update({ note: noteText }).eq("id", userId);

// With:
await db.runAsync(`UPDATE contacts SET status = ? WHERE id = ?`, [
  noteText,
  userId,
]);
await LocalDBService.enqueueOrMergeSyncOp({
  entity_type: "profile",
  entity_id: userId,
  op_type: "profile_update",
  payload: JSON.stringify({ note: noteText }),
  priority: 2,
});
```

---

## 4. HUMAN-IN-THE-LOOP TESTING PROTOCOLS

### 4.1 Phase-Level Smoke Tests (run after each phase)

| Phase | Test                                 | Expected Result                              |
| ----- | ------------------------------------ | -------------------------------------------- |
| 0     | Run `npx tsc --noEmit`               | Zero TypeScript errors                       |
| 1     | Open app, check console              | "[DB] Migrations complete" logged            |
| 2     | Send a photo, kill the app, reopen   | Photo still visible (from local URI)         |
| 3     | Go to airplane mode, send 5 texts    | All 5 appear instantly with ⏳ status        |
| 3     | Reconnect from airplane mode         | All 5 status icons turn to ✓ within 10s      |
| 4     | Go offline, open a chat              | Avatars render without network spinner       |
| 5     | Airplane mode, mark messages as read | Blue ticks appear locally                    |
| 5     | Reconnect                            | Server confirms read receipts; no duplicates |
| 6     | Post a status on airplane mode       | Status appears in local feed immediately     |
| 7     | Fill storage manually, trigger GC    | Old media files deleted, app does not crash  |

---

### 4.2 Network Drop Simulation

**iOS Simulator:**

```
Hardware → Network Link Conditioner → Enable
Profile: "Very Bad Network" (0.1 Mbps, 500ms latency, 20% packet loss)
Or: Toggle Airplane Mode mid-test via Settings
```

**Android Emulator:**

```
Extended Controls (⋮) → Cellular → Network type: GSM
Or use: adb shell svc wifi disable
```

**Physical Device (best test):**

```
Enter a building basement / elevator for natural signal loss.
Or: Settings → Airplane Mode mid-message-send.
```

---

### 4.3 RAM Pressure Simulation

**iOS:**

```
XCode → Debug → Simulate Memory Warning
```

**Android:**

```
adb shell am send-trim-memory com.soul.app RUNNING_CRITICAL
```

**Expected:** App does not crash. Chat history reloads from SQLite instantly (no network spinner). No data loss.

---

### 4.4 Duplicate Message Test

```
1. Disable internet on device.
2. Send a message — verify it appears with idempotency_key in SQLite.
3. Re-enable internet.
4. Watch the Supabase Realtime console.
5. In SQLite Browser, confirm only ONE row exists for this message.
6. Confirm the row has both a local id AND a server_id populated.
```

---

### 4.5 Storage Permission Denial Test

```
1. Go to Phone Settings → Apps → Soul → Permissions → Deny Storage.
2. Try to send a photo.
3. Expected: Toast/banner appears "Storage permission needed for offline media."
4. Expected: App does NOT crash. Upload proceeds via direct-upload fallback.
5. Expected: No Base64 error in console.
```

---

### 4.6 Queue Correctness Tests

**Payload Merging:**

```
1. Go offline.
2. Update your bio 5 times.
3. Open SQLite Browser → pending_sync_ops table.
4. Expected: Only ONE row with op_type='profile_update' for your user_id.
5. Expected: payload contains the 5th (latest) bio text.
```

**Exponential Backoff:**

```
1. In SyncWorker, temporarily add: if (op.op_type === 'send_message') throw new Error('test')
2. Send a message.
3. Watch console: delays should be ~2s, ~4s, ~8s, ~16s...
4. Restore the throw line after verification.
```

---

### 4.7 Garbage Collection Test

```
1. In GarbageCollectionService, temporarily set the threshold to NOW() - 1 MINUTE.
2. Send a photo, confirm it uploads (has media_url).
3. Wait 2 minutes.
4. Foreground the app.
5. Expected: Soul/Media/ file is deleted.
6. Expected: message.local_file_uri = NULL in SQLite.
7. Expected: Image in chat loads from media_url (remote) instead.
```

---

## 5. APPENDIX: SCHEMA REFERENCE & FILE MAP

### 5.1 Final SQLite Schema (Post-Migration)

```sql
-- messages (modified)
CREATE TABLE messages (
  id TEXT PRIMARY KEY,                    -- local UUID (permanent)
  server_id TEXT,                         -- Supabase UUID (nullable until synced)
  chat_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  receiver TEXT NOT NULL,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|uploading|sent|delivered|read|failed
  local_file_uri TEXT,                    -- file://...Soul/Media/
  media_url TEXT,                         -- remote Cloudflare R2 URL
  media_type TEXT,
  is_unsent INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  idempotency_key TEXT UNIQUE NOT NULL,
  starred INTEGER NOT NULL DEFAULT 0,
  gc_protected INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- pending_sync_ops (modified)
CREATE TABLE pending_sync_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op_type TEXT NOT NULL,
  payload TEXT NOT NULL,                  -- JSON string
  priority INTEGER NOT NULL DEFAULT 1,   -- 0=P0, 1=P1, 2=P2, 3=P3
  status TEXT NOT NULL DEFAULT 'pending',-- pending|processing|done|failed
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_attempted_at INTEGER,
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);

-- contacts (modified)
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  name TEXT,
  avatar TEXT,                            -- remote URL (fallback)
  local_avatar_uri TEXT,                  -- file://...Soul/Avatars/ (preferred)
  status TEXT,
  last_seen INTEGER
);

-- statuses (new)
CREATE TABLE statuses (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  media_type TEXT,
  local_file_uri TEXT,
  media_url TEXT,
  caption TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  server_id TEXT,
  idempotency_key TEXT UNIQUE NOT NULL
);
```

### 5.2 New Files Created by This Refactor

```
mobile/
├── constants/
│   └── Features.ts                     ← Phase 0.1
├── services/
│   ├── ErrorService.ts                 ← Phase 0.2
│   ├── FileSystemService.ts            ← Phase 0.3
│   ├── MediaUploadWorker.ts            ← Phase 2.2
│   ├── AvatarCacheService.ts           ← Phase 4.1
│   ├── SyncWorker.ts                   ← Phase 5.1
│   └── GarbageCollectionService.ts     ← Phase 7.1
├── database/
│   └── migrations.ts                   ← Phase 0.4 / Phase 1
├── hooks/
│   └── useLiveMessages.ts              ← Phase 3.1
└── utils/
    └── mediaUtils.ts                   ← Phase 2.1
```

### 5.3 Files Modified by This Refactor

```
mobile/
├── services/
│   ├── ChatService.ts      ← Phase 3.5, 3.6, 5.3
│   ├── StatusService.ts    ← Phase 6.1
│   ├── LocalDBService.ts   ← Phase 3.3, 5.4
│   └── BackgroundSyncService.ts ← Phase 4.3, 5.5
├── screens/
│   └── SingleChatScreen.tsx ← Phase 2.1, 3.2, 3.4
└── components/
    ├── SoulAvatar.tsx       ← Phase 4.2
    └── MessageBubble.tsx    ← Phase 2.4
```

### 5.4 Execution Order Summary

```
Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8
  Prep    Schema   Media     UI Decouple  Avatars  SyncEngine  Status    GC     Profile
  ~1h     ~2h      ~4h        ~8h          ~3h       ~6h        ~2h      ~2h     ~1h
```

**Total estimated agent execution time (with human checkpoints): ~29 focused hours across 3-4 days.**

---

_Document generated for Soul App — Architecture version 1.0_  
_Stack: React Native 0.84.1 · expo-sqlite WAL · Supabase Realtime · Cloudflare R2_
