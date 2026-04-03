type Listener = (hidden: boolean) => void;

let isSourceHeroHidden = false;
const listeners = new Set<Listener>();

export const getProfileEditSourceHidden = () => isSourceHeroHidden;

export const setProfileEditSourceHidden = (hidden: boolean) => {
    if (isSourceHeroHidden === hidden) {
        return;
    }

    isSourceHeroHidden = hidden;
    listeners.forEach(listener => listener(hidden));
};

export const subscribeProfileEditSourceHidden = (listener: Listener) => {
    listeners.add(listener);
    listener(isSourceHeroHidden);

    return () => {
        listeners.delete(listener);
    };
};
