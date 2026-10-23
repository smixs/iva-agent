/** Display lists supplied with the artwork. Coordinates are design units. */
interface Photo {
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
  clip?: number[] | null;
}
interface Band {
  y: number;
  h: number;
  dx: number;
  amp: number;
  k: number;
  p: number;
}
interface Pixel {
  x: number;
  y: number;
  c: string;
  o: number;
  n: number;
  g: number;
  b: number;
  k: number;
  p: number;
  t0?: number;
  t1?: number;
  dx?: number;
  dy?: number;
  fade?: number;
}
interface Slice {
  x: number;
  y: number;
  w: number;
  h: number;
  c: string;
  o: number;
  amp: number;
  k: number;
  p: number;
  t0?: number;
  t1?: number;
}
type Layer =
  | ({ type: "photo" } & Photo)
  | ({ type: "glitch"; inside?: boolean; bands: Band[] } & Photo)
  | { type: "cells"; cell: number; items: Pixel[] }
  | { type: "slices"; items: Slice[] };
export interface Scene {
  size: number[];
  background: string;
  loop_seconds: number;
  still_t: number;
  layers: Layer[];
}
export function inWindow(tau: number, t0?: number, t1 = 1) {
  return (
    t0 === undefined ||
    (t0 <= t1 ? tau >= t0 && tau < t1 : tau >= t0 || tau < t1)
  );
}
export function cellVisible(c: Pixel, tau: number) {
  return (
    inWindow(tau, c.t0, c.t1) &&
    c.n < c.g * (1 - c.b + c.b * Math.sin(c.k * 2 * Math.PI * tau + c.p))
  );
}
function photo(
  ctx: CanvasRenderingContext2D,
  layer: Photo,
  image: CanvasImageSource,
  dx = 0,
  clip = layer.clip,
) {
  ctx.save();
  if (clip) {
    ctx.beginPath();
    ctx.rect(clip[0], clip[1], clip[2], clip[3]);
    ctx.clip();
  }
  ctx.drawImage(image, layer.x + dx, layer.y, layer.w, layer.h);
  ctx.restore();
}
export function renderScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  tau: number,
  images: Map<string, CanvasImageSource>,
  intro = 1,
) {
  const ph = 2 * Math.PI * tau,
    ease = 0.5 - 0.5 * Math.cos(ph),
    scale = ctx.canvas.width / scene.size[0];
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = scene.background;
  ctx.fillRect(0, 0, scene.size[0], scene.size[1]);
  for (const layer of scene.layers) {
    ctx.globalAlpha = 1;
    if (layer.type === "photo") {
      const image = images.get(layer.src);
      if (image) photo(ctx, layer, image);
    } else if (layer.type === "glitch") {
      const image = images.get(layer.src);
      if (!image) continue;
      if (layer.inside) photo(ctx, layer, image);
      for (const band of layer.bands) {
        if (layer.inside && band.dx === 0 && band.amp === 0) continue;
        const dx = band.dx + band.amp * Math.sin(band.k * ph + band.p);
        photo(ctx, layer, image, dx, [
          layer.x + (layer.inside ? 0 : dx),
          band.y,
          layer.w,
          band.h,
        ]);
      }
    } else if (layer.type === "cells") {
      for (const c of layer.items) {
        if (!cellVisible(c, tau)) continue;
        ctx.globalAlpha = c.o * (1 - (c.fade ?? 0) * ease) * intro;
        ctx.fillStyle = c.c;
        ctx.fillRect(
          c.x + (c.dx ?? 0) * ease,
          c.y + (c.dy ?? 0) * ease + (1 - intro) * layer.cell * 2,
          layer.cell,
          layer.cell,
        );
      }
    } else if (layer.type === "slices") {
      for (const c of layer.items) {
        if (!inWindow(tau, c.t0, c.t1)) continue;
        const width =
          c.w *
          (c.t0 === undefined
            ? 1
            : Math.max(0, Math.min(1, (tau - c.t0) / 0.06)));
        ctx.globalAlpha = c.o;
        ctx.fillStyle = c.c;
        ctx.fillRect(c.x + c.amp * Math.sin(c.k * ph + c.p), c.y, width, c.h);
      }
    }
  }
  ctx.globalAlpha = 1;
}
