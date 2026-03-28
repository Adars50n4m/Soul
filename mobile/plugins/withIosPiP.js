const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

function withIosPiP(config) {
  // 1. Ensure Background Modes are set (redundant with withCallKit but safe)
  config = withInfoPlist(config, (config) => {
    console.log('[withIosPiP] Modifying Info.plist (Background Modes)');
    const bgModes = config.modResults.UIBackgroundModes || [];
    if (!bgModes.includes('audio')) bgModes.push('audio');
    if (!bgModes.includes('voip')) bgModes.push('voip');
    if (!bgModes.includes('picture-in-picture')) bgModes.push('picture-in-picture');
    config.modResults.UIBackgroundModes = bgModes;
    return config;
  });

  // 2. Patch AppDelegate to configure AVAudioSession for PiP support
  config = withAppDelegate(config, (config) => {
    console.log('[withIosPiP] Modifying AppDelegate');
    if (config.modResults.language === 'swift') {
      config.modResults.contents = patchSwiftAppDelegate(config.modResults.contents);
    } else {
      config.modResults.contents = patchObjCAppDelegate(config.modResults.contents);
    }
    return config;
  });

  return config;
}

function patchSwiftAppDelegate(contents) {
  if (!contents.includes('import AVFoundation')) {
    contents = contents.replace('import Expo', 'import Expo\nimport AVFoundation');
  }

  const audioSetup = `
    // Configure AVAudioSession for Video Chat and PiP
    do {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .videoChat, options: [.allowBluetooth, .defaultToSpeaker])
        try session.setActive(true)
    } catch {
        print("Failed to set AVAudioSession category: \\(error)")
    }
`;

  if (!contents.includes('AVAudioSession.sharedInstance()')) {
    contents = contents.replace(
      'return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
      `${audioSetup}\n    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`
    );
    console.log('[withIosPiP] Patched AppDelegate (Swift)');
  }

  return contents;
}

function patchObjCAppDelegate(contents) {
  if (!contents.includes('#import <AVFoundation/AVFoundation.h>')) {
    contents = contents.replace('#import "AppDelegate.h"', '#import "AppDelegate.h"\n#import <AVFoundation/AVFoundation.h>');
  }

  const audioSetup = `
  // Configure AVAudioSession for Video Chat and PiP
  [[AVAudioSession sharedInstance] setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeVideoChat options:AVAudioSessionCategoryOptionAllowBluetooth | AVAudioSessionCategoryOptionDefaultToSpeaker error:nil];
  [[AVAudioSession sharedInstance] setActive:YES error:nil];
`;

  if (!contents.includes('AVAudioSessionCategoryPlayAndRecord')) {
    contents = contents.replace(
      'return [super application:application didFinishLaunchingWithOptions:launchOptions];',
      `${audioSetup}\n  return [super application:application didFinishLaunchingWithOptions:launchOptions];`
    );
    console.log('[withIosPiP] Patched AppDelegate (ObjC)');
  }

  return contents;
}

module.exports = withIosPiP;
