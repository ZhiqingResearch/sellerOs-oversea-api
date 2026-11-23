// Migrated from the accepted automotive audit script; runtime I/O is injected by the service.
import sharp from 'sharp';

export async function measureImage(bytes) {
  const { data, info } = await sharp(bytes).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const border = Math.max(1, Math.floor(Math.min(info.width, info.height) * 0.012));
  const counts = new Map();
  let borderPixels = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (x >= border && y >= border && x < info.width - border && y < info.height - border) continue;
    const offset = (y * info.width + x) * info.channels;
    const key = `${data[offset]},${data[offset + 1]},${data[offset + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1); borderPixels++;
  }
  const [dominantRgb, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const background = dominantRgb.split(',').map(Number);
  const boxes = [8, 16, 24, 32].map(threshold => {
    let left = info.width, top = info.height, right = -1, bottom = -1;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (Math.max(...background.map((value, channel) => Math.abs(data[offset + channel] - value))) <= threshold) continue;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    return { threshold, box: right < 0 ? null : [left, top, right, bottom], occupancy: right < 0 ? null : Math.max((right - left + 1) / info.width, (bottom - top + 1) / info.height) };
  });
  const size = Math.max(2, Math.floor(Math.min(info.width, info.height) * 0.005));
  const foreground = boxes.filter(item => item.box).map(item => item.box);
  const backgroundPatches = [[0, 0], [info.width - size, 0], [0, info.height - size], [info.width - size, info.height - size]].map(([left, top]) => {
    const min = [255, 255, 255], max = [0, 0, 0];
    for (let y = top; y < top + size; y++) for (let x = left; x < left + size; x++) {
      const offset = (y * info.width + x) * info.channels;
      for (let channel = 0; channel < 3; channel++) { min[channel] = Math.min(min[channel], data[offset + channel]); max[channel] = Math.max(max[channel], data[offset + channel]); }
    }
    const isOutsideForeground = foreground.length === 4 && foreground.every(([x1, y1, x2, y2]) => left + size <= x1 || left > x2 || top + size <= y1 || top > y2);
    return { box: [left, top, left + size - 1, top + size - 1], min, max, isOutsideForeground };
  });
  return { width: info.width, height: info.height, borderPixels, dominantRgb: background, dominantFraction: dominantCount / borderPixels, exactWhiteFraction: (counts.get('255,255,255') ?? 0) / borderPixels, boxes, backgroundPatches };
}
