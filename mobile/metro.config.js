const { getDefaultConfig } = require("expo/metro-config");
const { wrapWithReanimatedMetroConfig } = require("react-native-reanimated/metro-config");
const path = require("path");

module.exports = (() => {
    const config = getDefaultConfig(__dirname);
    
    // Ensure asset extensions include lottie
    config.resolver = {
        ...config.resolver,
        assetExts: [...(config.resolver?.assetExts || []), 'lottie'],
        alias: {
            "@": path.resolve(__dirname),
        },
    };
    
    return wrapWithReanimatedMetroConfig(config);
})();
