/**
 * How many loops an animated avatar plays, each time it comes into view, before
 * holding its first frame. On an Android WebView any animation on screen
 * recomposites the whole page every frame: one looping avatar measured ~60% of a
 * core on the GPU thread, in a timeline or on Discover alike. A profile's own
 * picture opts out (`AvatarImage`'s `loops`).
 */
export const AVATAR_LOOPS = 2;
