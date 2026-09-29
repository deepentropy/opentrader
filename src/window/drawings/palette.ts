/*
 * TV drawing color palette — captured verbatim from the live floating-toolbar
 * line-color picker (TV Desktop 3.1.0.7818). 8 rows × 10:
 *   row 0    = grayscale (white → black)
 *   row 1    = base hues
 *   rows 2-7 = tints (light) → shades (dark) of each hue column
 */
export const TV_COLOR_ROWS: readonly (readonly string[])[] = [
  ["#FFFFFF", "#DBDBDB", "#B8B8B8", "#9C9C9C", "#808080", "#636363", "#4A4A4A", "#2E2E2E", "#0F0F0F", "#000000"],
  ["#F23645", "#FF9800", "#FFEB3B", "#4CAF50", "#089981", "#00BCD4", "#2962FF", "#673AB7", "#9C27B0", "#E91E63"],
  ["#FCCBCD", "#FFE0B2", "#FFF9C4", "#C8E6C9", "#ACE5DC", "#B2EBF2", "#BBD9FB", "#D1C4E9", "#E1BEE7", "#F8BBD0"],
  ["#FAA1A4", "#FFCC80", "#FFF59D", "#A5D6A7", "#70CCBD", "#80DEEA", "#90BFF9", "#B39DDB", "#CE93D8", "#F48FB1"],
  ["#F77C80", "#FFB74D", "#FFF176", "#81C784", "#42BDA8", "#4DD0E1", "#5B9CF6", "#9575CD", "#BA68C8", "#F06292"],
  ["#F7525F", "#FFA726", "#FFEE58", "#66BB6A", "#22AB94", "#26C6DA", "#3179F5", "#7E57C2", "#AB47BC", "#EC407A"],
  ["#B22833", "#F57C00", "#FBC02D", "#388E3C", "#056656", "#0097A7", "#1848CC", "#512DA8", "#7B1FA2", "#C2185B"],
  ["#801922", "#E65100", "#F57F17", "#1B5E20", "#00332A", "#006064", "#0C3299", "#311B92", "#4A148C", "#880E4F"],
];
