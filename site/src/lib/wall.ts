// The phone's wallpaper is the largest thing in the first screen (its LCP). The phone's screen is
// at most 359 px wide (the hero in global.css), so phones at 1x, 1.5x and 2x each get their own
// file; Home.astro preloads the same set so the request starts with the page.
export const wall = {
  src: "/media/tg-wall.webp",
  srcset: "/media/tg-wall-402.webp 402w, /media/tg-wall-603.webp 603w, /media/tg-wall.webp 804w",
  sizes: "(max-width: 432px) calc(92.6vw - 41px), 359px",
};
