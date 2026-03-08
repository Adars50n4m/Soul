const { withAndroidManifest, withMainActivity } = require('expo/config-plugins');

function withAndroidPiP(config) {
  // 1. Modify AndroidManifest.xml
  config = withAndroidManifest(config, (config) => {
    console.log('[withAndroidPiP] Modifying AndroidManifest.xml');
    const manifest = config.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return config;
    
    const activities = application.activity || [];
    let mainActivity = activities.find(a => a.$?.['android:name'] === '.MainActivity');
    
    // Fallback: Find activity with MAIN and LAUNCHER intent
    if (!mainActivity) {
      mainActivity = activities.find(a => {
        const intentFilters = a['intent-filter'] || [];
        return intentFilters.some(f => {
          const actions = f.action || [];
          const categories = f.category || [];
          return actions.some(act => act.$?.['android:name'] === 'android.intent.action.MAIN') &&
                 categories.some(cat => cat.$?.['android:name'] === 'android.intent.category.LAUNCHER');
        });
      });
    }
    
    if (mainActivity) {
      console.log(`[withAndroidPiP] Found activity to patch: ${mainActivity.$?.['android:name'] || 'unknown'}`);
      if (!mainActivity.$) mainActivity.$ = {};
      mainActivity.$['android:supportsPictureInPicture'] = 'true';
      mainActivity.$['android:resizeableActivity'] = 'true';
      mainActivity.$['android:launchMode'] = 'singleTask';
      
      const configChanges = mainActivity.$['android:configChanges'] || '';
      const requiredConfigChanges = ['keyboard', 'keyboardHidden', 'orientation', 'screenSize', 'smallestScreenSize', 'screenLayout'];
      let changesArr = configChanges.split('|').map(x => x.trim()).filter(Boolean);
      for (const req of requiredConfigChanges) {
        if (!changesArr.includes(req)) {
          changesArr.push(req);
        }
      }
      mainActivity.$['android:configChanges'] = changesArr.join('|');
    } else {
      console.warn('[withAndroidPiP] No main activity found to patch in AndroidManifest.xml');
    }
    
    return config;
  });

  // 2. Patch MainActivity to override onUserLeaveHint
  config = withMainActivity(config, (config) => {
    console.log('[withAndroidPiP] Modifying MainActivity');
    if (config.modResults.language === 'java') {
      let content = config.modResults.contents;
      if (!content.includes('onUserLeaveHint')) {
        const insertionPoint = content.lastIndexOf('}');
        const onUserLeaveHintJava = `
  @Override
  protected void onUserLeaveHint() {
    super.onUserLeaveHint();
    // This allows the app to enter PiP mode when the user presses Home or Recents
  }
`;
        config.modResults.contents = content.slice(0, insertionPoint) + onUserLeaveHintJava + content.slice(insertionPoint);
      }
    } else {
      let content = config.modResults.contents;
      if (!content.includes('onUserLeaveHint')) {
        // Find last closing brace of the class
        const insertionPoint = content.lastIndexOf('}');
        const onUserLeaveHintKotlin = `
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // This allows the app to enter PiP mode when the user presses Home or Recents
        // Triggered natively by the system
    }
`;
        config.modResults.contents = content.slice(0, insertionPoint) + onUserLeaveHintKotlin + content.slice(insertionPoint);
        console.log('[withAndroidPiP] Patched MainActivity (Kotlin)');
      }
    }
    return config;
  });

  return config;
}

module.exports = withAndroidPiP;
