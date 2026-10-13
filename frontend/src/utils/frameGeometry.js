// Geometry of a dragged or resized in-app window (FloatingWindow, ComposeModal) in the units its
// left/top/width/height are written in (#591).
//
// MailApp scales the whole interface with transform: scale() for the font-size setting. A
// position: fixed element inside it is then laid out in the scaled wrapper's pixels, while
// getBoundingClientRect() and pointer coordinates are in screen pixels. Reading the window's box
// with getBoundingClientRect() and writing it back as left/width multiplied it by the scale on
// every grab: at 125% a click on the title bar moved the window down-right and grew it by a
// quarter, until it ran off the screen.
//
// So positions and sizes are read from layout (computed left/top, offsetWidth/offsetHeight),
// pointer movement is divided by the scale, and the screen is measured in layout pixels too.
// Popovers placed from getBoundingClientRect() make the same correction with hooks/useUiScale.js;
// a window reads its own layout instead, which is exact, where dividing screen pixels by the scale
// would let rounding creep in over repeated drags.

// Screen pixels per CSS pixel of the element's own layout: the font-size scale, 1 without it.
export function layoutScale(el) {
  const laidOut = el.offsetWidth;
  const onScreen = el.getBoundingClientRect().width;
  return laidOut > 0 && onScreen > 0 ? onScreen / laidOut : 1;
}

// { x, y, w, h } as the element's own left/top/width/height, the scale, and the screen's size in
// the same units (the wrapper fills the screen from its top-left corner).
export function frameGeometry(el) {
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  const scale = layoutScale(el);
  const win = el.ownerDocument.defaultView;
  return {
    x: Number.parseFloat(style.left) || 0,
    y: Number.parseFloat(style.top) || 0,
    w: el.offsetWidth,
    h: el.offsetHeight,
    scale,
    viewW: win.innerWidth / scale,
    viewH: win.innerHeight / scale,
  };
}
