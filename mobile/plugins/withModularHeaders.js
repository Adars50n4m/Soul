const { withPodfile } = require('expo/config-plugins');

function withModularHeaders(config) {
  return withPodfile(config, (config) => {
    let contents = config.modResults.contents;
    
    // specifically for Firebase/Google pods
    if (!contents.includes("pod 'GoogleUtilities'")) {
      contents = contents.replace(
        "use_expo_modules!",
      );
    }

    // Xcode 16 and Frameworks fix
    const explicitModulesFix = `
      # Fix for Pods targets
      installer.pods_project.targets.each do |target|
        target.build_configurations.each do |config|
          config.build_settings['CLANG_ENABLE_EXPLICIT_MODULES'] = 'NO'
          config.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'
          config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.1'
          config.build_settings['ENABLE_USER_SCRIPT_SANDBOXING'] = 'NO'
        end
      end
      
      # Fix for Main Project targets
      installer.aggregate_targets.each do |target|
        target.user_project.targets.each do |project_target|
          project_target.build_configurations.each do |config|
            config.build_settings['CLANG_ENABLE_EXPLICIT_MODULES'] = 'NO'
            config.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'
            config.build_settings['ENABLE_USER_SCRIPT_SANDBOXING'] = 'NO'
          end
        end
      end`;

    if (!contents.includes('CLANG_ENABLE_EXPLICIT_MODULES')) {
      contents = contents.replace(
        /react_native_post_install\((\s*)installer,(\s*)config\[:reactNativePath\],(\s*):mac_catalyst_enabled => false,(\s*):ccache_enabled => ccache_enabled\?\(podfile_properties\),(\s*)\)/,
        `react_native_post_install($1installer,$2config[:reactNativePath],$3:mac_catalyst_enabled => false,$4:ccache_enabled => ccache_enabled?(podfile_properties),$5)\n${explicitModulesFix}`
      );
    }
    
    config.modResults.contents = contents;
    return config;
  });
}

module.exports = withModularHeaders;
