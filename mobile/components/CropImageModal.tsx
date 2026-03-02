import React, { useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Pressable,
  Text,
  Modal,
  ActivityIndicator,
  ScrollView,
  PanResponder,
  GestureResponderEvent,
  PanResponderGestureState,
  Alert,
  Image as RNImage,
  Dimensions,
  Platform
} from 'react-native';
import { Image } from 'expo-image';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImageManipulator from 'expo-image-manipulator';

const MIN_SIZE = 60;

interface Props {
  visible: boolean;
  imageUri: string,
  onClose: () => void;
  onCropComplete: (uri: string) => void;
}

type CropBox = { x: number; y: number; w: number; h: number };
type DragTarget = 'TL' | 'TR' | 'BL' | 'BR' | 'CENTER' | null;

export const CropImageModal: React.FC<Props> = ({ visible, imageUri, onClose, onCropComplete }) => {
  const insets = useSafeAreaInsets();

  // Normalized URI (EXIF baked in) + its true pixel dimensions
  const [normalizedUri, setNormalizedUri] = useState<string | null>(null);
  const [imgW, setImgW] = useState(0);
  const [imgH, setImgH] = useState(0);

  // Display dimensions (how big the image looks on screen)
  const [dispW, setDispW] = useState(0);
  const [dispH, setDispH] = useState(0);
  const [dispX, setDispX] = useState(0);
  const [dispY, setDispY] = useState(0);

  // Container size
  const [canvasW, setCanvasW] = useState(0);
  const [canvasH, setCanvasH] = useState(0);

  // Crop box in display-space pixels (relative to image top-left)
  const [crop, setCrop] = useState<CropBox>({ x: 0, y: 0, w: 0, h: 0 });

  const [rotation, setRotation] = useState(0);
  const [mirrored, setMirrored] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [aspectMenu, setAspectMenu] = useState(false);
  const [isReady, setIsReady] = useState(false);

  // STEP 1: On open, normalize the image to bake in EXIF rotation.
  useEffect(() => {
    if (!visible || !imageUri) return;

    setRotation(0);
    setMirrored(false);
    setIsProcessing(false);
    setAspectMenu(false);
    setNormalizedUri(null);
    setImgW(0);
    setImgH(0);
    setDispW(0);
    setDispH(0);
    setIsReady(false);

    // Normalize: run with empty actions to bake EXIF
    ImageManipulator.manipulateAsync(imageUri, [], {
      format: ImageManipulator.SaveFormat.JPEG,
      compress: 1,
    })
        .then((result) => {
          setNormalizedUri(result.uri);
          if (result.width && result.height) {
            setImgW(result.width);
            setImgH(result.height);
          } else {
            RNImage.getSize(
              result.uri,
              (w, h) => {
                setImgW(w);
                setImgH(h);
              },
              () => {}
            );
          }
        })
        .catch((err) => {
          console.warn('[CropModal] Normalize failed, using original:', err);
          setNormalizedUri(imageUri);
          RNImage.getSize(
            imageUri,
            (w, h) => { setImgW(w); setImgH(h); },
            () => {}
          );
        });
  }, [visible, imageUri]);

  // STEP 2: Compute display layout when we know image size + container size
  useEffect(() => {
    if (imgW <= 0 || imgH <= 0 || canvasW <= 0 || canvasH <= 0) return;

    const scale = Math.min(canvasW / imgW, canvasH / imgH);
    const dw = imgW * scale;
    const dh = imgH * scale;
    const dx = (canvasW - dw) / 2;
    const dy = (canvasH - dh) / 2;

    setDispW(dw);
    setDispH(dh);
    setDispX(dx);
    setDispY(dy);
    setCrop({ x: 0, y: 0, w: dw, h: dh });
    setIsReady(true);
  }, [imgW, imgH, canvasW, canvasH]);

  // ---- Pan Responder for crop box manipulation ----
  const dragTarget = React.useRef<DragTarget>(null);
  const startCrop = React.useRef<CropBox>({ x: 0, y: 0, w: 0, h: 0 });
  const CORNER_HIT = 40;

  const getTarget = (px: number, py: number, c: CropBox): DragTarget => {
    if (Math.abs(px - c.x) < CORNER_HIT && Math.abs(py - c.y) < CORNER_HIT) return 'TL';
    if (Math.abs(px - (c.x + c.w)) < CORNER_HIT && Math.abs(py - c.y) < CORNER_HIT) return 'TR';
    if (Math.abs(px - c.x) < CORNER_HIT && Math.abs(py - (c.y + c.h)) < CORNER_HIT) return 'BL';
    if (Math.abs(px - (c.x + c.w)) < CORNER_HIT && Math.abs(py - (c.y + c.h)) < CORNER_HIT) return 'BR';
    if (px > c.x && px < c.x + c.w && py > c.y && py < c.y + c.h) return 'CENTER';
    return null;
  };

  const currentCropRef = React.useRef(crop);
  currentCropRef.current = crop;

  const panResponder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt: GestureResponderEvent) => {
          const lx = evt.nativeEvent.locationX;
          const ly = evt.nativeEvent.locationY;
          dragTarget.current = getTarget(lx, ly, currentCropRef.current);
          startCrop.current = { ...currentCropRef.current };
        },
        onPanResponderMove: (_: GestureResponderEvent, gs: PanResponderGestureState) => {
          const { dx, dy } = gs;
          const s = startCrop.current;
          const bw = dispW;
          const bh = dispH;

          let { x, y, w, h } = s;
          switch (dragTarget.current) {
            case 'TL': {
              const nx = Math.min(Math.max(0, x + dx), x + w - MIN_SIZE);
              const ny = Math.min(Math.max(0, y + dy), y + h - MIN_SIZE);
              w = w + (x - nx);
              h = h + (y - ny);
              x = nx;
              y = ny;
              break;
            }
            case 'TR': {
              const ny = Math.min(Math.max(0, y + dy), y + h - MIN_SIZE);
              w = Math.min(Math.max(MIN_SIZE, w + dx), bw - x);
              h = h + (y - ny);
              y = ny;
              break;
            }
            case 'BL': {
              const nx = Math.min(Math.max(0, x + dx), x + w - MIN_SIZE);
              w = w + (x - nx);
              x = nx;
              h = Math.min(Math.max(MIN_SIZE, h + dy), bh - y);
              break;
            }
            case 'BR': {
              w = Math.min(Math.max(MIN_SIZE, w + dx), bw - x);
              h = Math.min(Math.max(MIN_SIZE, h + dy), bh - y);
              break;
            }
            case 'CENTER': {
              x = Math.min(Math.max(0, x + dx), bw - w);
              y = Math.min(Math.max(0, y + dy), bh - h);
              break;
            }
          }
          setCrop({ x, y, w, h });
        },
        onPanResponderRelease: () => {
          dragTarget.current = null;
        },
      }),
    [dispW, dispH]
  );

  const applyAspectRatio = (ratio: number | null) => {
    setAspectMenu(false);
    let nx = 0,
      ny = 0,
      nw = dispW,
      nh = dispH;
    if (ratio !== null) {
      nw = dispW;
      nh = nw / ratio;
      if (nh > dispH) {
        nh = dispH;
        nw = nh * ratio;
      }
      nx = (dispW - nw) / 2;
      ny = (dispH - nh) / 2;
    }
    setCrop({ x: nx, y: ny, w: nw, h: nh });
  };

  const handleDone = async () => {
    if (isProcessing || !normalizedUri || dispW === 0 || imgW === 0) return;
    setIsProcessing(true);

    try {
      const relativeX = crop.x / dispW;
      const relativeY = crop.y / dispH;
      const relativeW = crop.w / dispW;
      const relativeH = crop.h / dispH;

      const isRotated90or270 = rotation === 90 || rotation === 270;
      const rotatedW = isRotated90or270 ? imgH : imgW;
      const rotatedH = isRotated90or270 ? imgW : imgH;

      let originX = Math.max(0, Math.round(relativeX * rotatedW));
      let originY = Math.max(0, Math.round(relativeY * rotatedH));
      let width = Math.max(1, Math.round(relativeW * rotatedW));
      let height = Math.max(1, Math.round(relativeH * rotatedH));

      if (rotation === 180) {
        originX = Math.max(0, Math.round((1 - relativeX - relativeW) * rotatedW));
        originY = Math.max(0, Math.round((1 - relativeY - relativeH) * rotatedH));
      }

      width = Math.min(width, rotatedW - originX);
      height = Math.min(height, rotatedH - originY);

      const actions: ImageManipulator.Action[] = [];
      
      if (rotation !== 0) {
        actions.push({ rotate: rotation });
      }
      
      if (mirrored) {
        actions.push({ flip: ImageManipulator.FlipType.Horizontal });
      }
      
      actions.push({ crop: { originX, originY, width, height } });

      const result = await ImageManipulator.manipulateAsync(normalizedUri, actions, {
        compress: 1,
        format: ImageManipulator.SaveFormat.JPEG,
      });

      onCropComplete(result.uri);
    } catch (e) {
      console.error('[CropModal] Crop error:', e);
      onClose();
    } finally {
      setIsProcessing(false);
    }
  };

  const RATIOS = [
    { label: 'Original', ratio: null },
    { label: 'Square', ratio: 1 },
    { label: '2:3', ratio: 2 / 3 },
    { label: '3:5', ratio: 3 / 5 },
    { label: '3:4', ratio: 3 / 4 },
    { label: '4:5', ratio: 4 / 5 },
    { label: '5:7', ratio: 5 / 7 },
    { label: '9:16', ratio: 9 / 16 },
  ];

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="fade" transparent={false} onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View
          style={styles.canvas}
          onLayout={(e) => {
            setCanvasW(e.nativeEvent.layout.width);
            setCanvasH(e.nativeEvent.layout.height);
          }}
        >
          {isReady && normalizedUri ? (
            <View
              style={{
                position: 'absolute',
                width: dispW,
                height: dispH,
                left: dispX,
                top: dispY,
              }}
              {...panResponder.panHandlers}
            >
              <Image
                source={{ uri: normalizedUri }}
                style={{
                  width: dispW,
                  height: dispH,
                  transform: [
                    { rotate: `${rotation}deg` },
                    { scaleX: mirrored ? -1 : 1 },
                  ],
                }}
                contentFit="fill"
              />

              <View style={[styles.ov, { top: 0, left: 0, right: 0, height: crop.y }]} />
              <View style={[styles.ov, { top: crop.y + crop.h, left: 0, right: 0, bottom: 0 }]} />
              <View style={[styles.ov, { top: crop.y, left: 0, width: crop.x, height: crop.h }]} />
              <View style={[styles.ov, { top: crop.y, left: crop.x + crop.w, right: 0, height: crop.h }]} />

              <View style={[styles.cropBox, { left: crop.x, top: crop.y, width: crop.w, height: crop.h }]}>
                <View style={styles.mTL} />
                <View style={styles.mTR} />
                <View style={styles.mBL} />
                <View style={styles.mBR} />
              </View>
            </View>
          ) : (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={{ color: '#888', marginTop: 12 }}>Preparing image...</Text>
            </View>
          )}
        </View>

        <View style={styles.toolbar}>
          <View style={styles.toolRow}>
            <Pressable onPress={() => setRotation((p) => (p - 90 + 360) % 360)} style={styles.iconBtn}>
              <MaterialCommunityIcons name="crop-rotate" size={26} color="#fff" />
            </Pressable>
            <Pressable onPress={() => setMirrored((p) => !p)} style={styles.iconBtn}>
              <MaterialIcons name="flip" size={26} color={mirrored ? '#4dabf7' : '#fff'} />
            </Pressable>
            <Pressable onPress={() => setAspectMenu((p) => !p)} style={styles.iconBtn}>
              <MaterialIcons name="aspect-ratio" size={26} color="#fff" />
            </Pressable>
          </View>
          <View style={styles.actionRow}>
            <Pressable onPress={onClose} style={styles.actionBtn}>
              <Text style={styles.actionText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={handleDone} style={styles.actionBtn} disabled={isProcessing}>
              {isProcessing ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={[styles.actionText, { fontWeight: '700' }]}>Done</Text>
              )}
            </Pressable>
          </View>
        </View>

        {aspectMenu && (
          <View style={styles.aspectMenu}>
            <ScrollView bounces={false}>
              {RATIOS.map((item, i) => (
                <Pressable
                  key={i}
                  onPress={() => applyAspectRatio(item.ratio)}
                  style={[
                    styles.aspectItem,
                    i < RATIOS.length - 1 && { borderBottomWidth: 0.5, borderBottomColor: '#555' },
                  ]}
                >
                  <Text style={styles.aspectText}>{item.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
      </View>
    </Modal>
  );
};

const M = 24;
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },
  canvas: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  ov: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.72)' },
  cropBox: {
    position: 'absolute',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.8)',
  },
  mTL: { position: 'absolute', top: -3, left: -3, width: M, height: M, borderTopWidth: 4, borderLeftWidth: 4, borderColor: '#fff' },
  mTR: { position: 'absolute', top: -3, right: -3, width: M, height: M, borderTopWidth: 4, borderRightWidth: 4, borderColor: '#fff' },
  mBL: { position: 'absolute', bottom: -3, left: -3, width: M, height: M, borderBottomWidth: 4, borderLeftWidth: 4, borderColor: '#fff' },
  mBR: { position: 'absolute', bottom: -3, right: -3, width: M, height: M, borderBottomWidth: 4, borderRightWidth: 4, borderColor: '#fff' },
  toolbar: { backgroundColor: '#262626' },
  toolRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 14,
    paddingHorizontal: 24,
  },
  iconBtn: { padding: 10 },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: '#333',
  },
  actionBtn: { paddingVertical: 4, paddingHorizontal: 8 },
  actionText: { color: '#fff', fontSize: 16 },
  aspectMenu: {
    position: 'absolute',
    bottom: 110,
    right: 16,
    width: 200,
    maxHeight: 360,
    backgroundColor: '#3a3a3c',
    borderRadius: 12,
    overflow: 'hidden',
    elevation: 12,
  },
  aspectItem: { paddingVertical: 14, paddingHorizontal: 16 },
  aspectText: { color: '#fff', fontSize: 16 },
});
