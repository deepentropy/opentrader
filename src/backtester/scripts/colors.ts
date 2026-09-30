import { color } from 'oakscriptjs/script';

// color.new() and color.rgb() always return a CSS string, but oakscriptjs types them as `color`
// (string | number), while plot() / fill() / plotshape() take strings.

/** color.new(base, transp) */
export const colorNew = (base: string, transp: number): string => color.new(base, transp) as string;
/** color.rgb(r, g, b, transp?) */
export const colorRgb = (r: number, g: number, b: number, transp?: number): string => color.rgb(r, g, b, transp) as string;
