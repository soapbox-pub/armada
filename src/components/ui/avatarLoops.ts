import { createContext } from "react";

/**
 * How many loops an animated avatar plays, each time it comes into view, before
 * holding its first frame. Lists set {@link LIST_AVATAR_LOOPS}: on an Android
 * WebView any animation on screen recomposites the whole page every frame, and one
 * looping avatar in a timeline measured ~60% of a core on the GPU thread.
 */
export const AvatarLoopsContext = createContext(Infinity);

/** Loops an animated avatar plays in a timeline or member list. */
export const LIST_AVATAR_LOOPS = 2;
