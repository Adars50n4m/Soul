/**
 * Expo Config Plugin: withCallKit
 * 
 * Configures the iOS native project for CallKit + VoIP Push support.
 * Supports both Objective-C and Swift AppDelegate.
 */

const { withInfoPlist, withEntitlementsPlist, withAppDelegate, withDangerousMod } = require('expo/config-plugins');

function withCallKitPlugin(config) {
  // Step 1: Add VoIP background mode to Info.plist
  config = withInfoPlist(config, (config) => {
    const bgModes = config.modResults.UIBackgroundModes || [];
    
    if (!bgModes.includes('voip')) bgModes.push('voip');
    if (!bgModes.includes('audio')) bgModes.push('audio');
    
    config.modResults.UIBackgroundModes = bgModes;
    return config;
  });

  // Step 2: Add VoIP push entitlement (Temporarily disabled for "Lite" mode)
  /*
  config = withEntitlementsPlist(config, (config) => {
    config.modResults['aps-environment'] = 'development';
    return config;
  });
  */

  // Step 3: Patch AppDelegate
  config = withAppDelegate(config, (config) => {
    if (config.modResults.language === 'swift') {
      config.modResults.contents = patchSwiftAppDelegate(config.modResults.contents);
    } else {
      config.modResults.contents = patchObjCAppDelegate(config.modResults.contents);
    }
    return config;
  });

  // Step 4: Patch Bridging Header
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const fs = require('fs');
      const path = require('path');
      const bridgingHeaderPath = path.join(config.modRequest.platformProjectRoot, config.modRequest.projectName, `${config.modRequest.projectName}-Bridging-Header.h`);
      if (fs.existsSync(bridgingHeaderPath)) {
        let contents = fs.readFileSync(bridgingHeaderPath, 'utf8');
        if (!contents.includes('RNCallKeep.h')) {
          contents += '\n#import "RNVoipPushNotificationManager.h"\n#import "RNCallKeep.h"\n';
          fs.writeFileSync(bridgingHeaderPath, contents);
        }
      }
      return config;
    },
  ]);

  return config;
}

function patchSwiftAppDelegate(contents) {
  // 1. Add imports
  if (!contents.includes('import PushKit')) {
    contents = contents.replace('import Expo', 'import Expo\nimport PushKit\nimport CallKit');
  }

  // 2. Add Delegate conformance
  if (!contents.includes('PKPushRegistryDelegate')) {
    contents = contents.replace(
      'class AppDelegate: ExpoAppDelegate {',
      'class AppDelegate: ExpoAppDelegate, PKPushRegistryDelegate {'
    );
  }

  // 3. Add Initialization in didFinishLaunching
  if (!contents.includes('RNVoipPushNotificationManager.voipRegistration')) {
    const initCode = `
    // Register for VoIP pushes
    RNVoipPushNotificationManager.voipRegistration()
    
    // Setup CallKeep
    RNCallKeep.setup([
      "appName": "SoulSync",
      "maximumCallGroups": 1,
      "maximumCallsPerCallGroup": 1,
      "supportsVideo": true
    ])
    `;
    contents = contents.replace(
      'return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
      `${initCode}\n    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`
    );
  }

  // 4. Add Delegate methods before the last closing brace
  if (!contents.includes('didUpdate credentials')) {
    const delegateMethods = `
  // MARK: - PKPushRegistryDelegate

  public func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    RNVoipPushNotificationManager.didUpdate(credentials, forType: type.rawValue)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completionHandler: @escaping () -> Void) {
    let dict = payload.dictionaryPayload as? [String: Any] ?? [:]
    let uuid = (dict["callId"] as? String) ?? (dict["uuid"] as? String) ?? UUID().uuidString
    let callerName = (dict["callerName"] as? String) ?? "Unknown Caller"
    let handle = (dict["callerId"] as? String) ?? "unknown"
    let hasVideo = (dict["callType"] as? String) == "video"

    RNCallKeep.reportNewIncomingCall(
      uuid,
      handle: handle,
      handleType: "generic",
      hasVideo: hasVideo,
      localizedCallerName: callerName,
      supportsHolding: true,
      supportsDTMF: true,
      supportsGrouping: true,
      supportsUngrouping: true,
      fromPushKit: true,
      payload: dict,
      withCompletionHandler: completionHandler
    )

    RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
  }
`;
    // Insert after the continueUserActivity restorationHandler
    contents = contents.replace(
      /(return super\.application\(application, continue: userActivity, restorationHandler: restorationHandler\) \|\| result\n\s*\})/,
      '$1\n' + delegateMethods
    );
  }

  return contents;
}

function patchObjCAppDelegate(contents) {
  if (!contents.includes('#import <PushKit/PushKit.h>')) {
    contents = contents.replace(
      '#import <UIKit/UIKit.h>',
      '#import <UIKit/UIKit.h>\n#import <PushKit/PushKit.h>\n#import "RNVoipPushNotificationManager.h"\n#import "RNCallKeep.h"'
    );
  }

  if (!contents.includes('PKPushRegistryDelegate')) {
    contents = contents.replace('@interface AppDelegate', '@interface AppDelegate <PKPushRegistryDelegate>');
  }

  if (!contents.includes('pushRegistry:didUpdatePushCredentials')) {
    const methods = `
- (void)pushRegistry:(PKPushRegistry *)registry didUpdatePushCredentials:(PKPushCredentials *)credentials forType:(PKPushType)type {
  [RNVoipPushNotificationManager didUpdatePushCredentials:credentials forType:(NSString *)type];
}

- (void)pushRegistry:(PKPushRegistry *)registry didReceiveIncomingPushWithPayload:(PKPushPayload *)payload forType:(PKPushType)type withCompletionHandler:(void (^)(void))completion {
  NSString *uuid = payload.dictionaryPayload[@"callId"] ?: payload.dictionaryPayload[@"uuid"] ?: [[NSUUID UUID] UUIDString];
  NSString *callerName = payload.dictionaryPayload[@"callerName"] ?: @"Unknown Caller";
  NSString *handle = payload.dictionaryPayload[@"callerId"] ?: @"unknown";
  BOOL hasVideo = [payload.dictionaryPayload[@"callType"] isEqualToString:@"video"];
  
  [RNCallKeep reportNewIncomingCall:uuid handle:handle handleType:@"generic" hasVideo:hasVideo localizedCallerName:callerName supportsHolding:YES supportsDTMF:YES supportsGrouping:YES supportsUngrouping:YES fromPushKit:YES payload:payload.dictionaryPayload withCompletionHandler:completion];
  [RNVoipPushNotificationManager didReceiveIncomingPushWithPayload:payload forType:(NSString *)type];
}
`;
    contents = contents.replace('@end', methods + '\n@end');
  }

  return contents;
}

module.exports = withCallKitPlugin;
