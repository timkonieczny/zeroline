import { CanvasTexture, LinearFilter, Mesh, PlaneGeometry, SRGBColorSpace, Vector2, Vector4 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { color, float, texture as textureNode, uniform, uv } from 'three/tsl';
import { UI_FONT, UI_WEIGHT } from './Fonts';

export type TextAlign = 'left' | 'centre' | 'right';

export interface TextStyle {
  /** Cap height in layout pixels. */
  size?: number;
  /** Font weight. Geo has only one, so this is 400 everywhere. */
  weight?: number;
  /** Extra tracking as a fraction of the size. */
  tracking?: number;
  colour?: number;
  align?: TextAlign;
  /**
   * Forces uppercase. Off by default: the interface is set in sentence case,
   * and the only things shouted are the ones that are genuinely abbreviations —
   * constructor tags, nation codes, the wordmark.
   */
  upper?: boolean;
  /**
   * Soft black halo behind the glyphs, as a fraction of the point size.
   * Zero for anything on a controlled background; a HUD over daylight needs
   * about a quarter.
   */
  shadow?: number;
  /** Italic. The display cut, used for headlines and for anything singled out. */
  italic?: boolean;
  /** Font stack. Defaults to the UI face. */
  family?: string;
}

const DEFAULT_FAMILY = UI_FONT;
/** Extra canvas pixels around the glyphs so nothing is clipped. */
const PADDING = 8;

/**
 * Renders a string into a canvas and hands back a texture plus its size.
 *
 * Canvas text rather than an MSDF atlas or a font loader: the UI is a few dozen
 * short strings, they change rarely, and canvas gives real kerning, real
 * letter-spacing and pin-sharp glyphs at whatever pixel density the display
 * happens to have — with no asset to ship.
 */
export function renderTextTexture(
  value: string,
  style: TextStyle,
  pixelRatio: number,
): { texture: CanvasTexture; width: number; height: number; bleed: number } {
  const size = style.size ?? 24;
  const weight = style.weight ?? UI_WEIGHT;
  const tracking = style.tracking ?? 0.18;
  const family = style.family ?? DEFAULT_FAMILY;
  const text = style.upper ? value.toUpperCase() : value;
  const shadow = style.shadow ?? 0;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const font = `${style.italic ? 'italic ' : ''}${weight} ${size}px ${family}`;

  context.font = font;
  context.letterSpacing = `${size * tracking}px`;
  const metrics = context.measureText(text);
  // The blur needs room in the bitmap or it is clipped at the glyph's edge.
  const bleed = Math.ceil(size * shadow * 2);
  const width = Math.ceil(metrics.width) + (PADDING + bleed) * 2 + (style.italic ? Math.ceil(size * 0.25) : 0);
  const height = Math.ceil(size * 1.45) + (PADDING + bleed) * 2;

  canvas.width = Math.max(1, Math.ceil(width * pixelRatio));
  canvas.height = Math.max(1, Math.ceil(height * pixelRatio));

  context.scale(pixelRatio, pixelRatio);
  context.font = font;
  context.letterSpacing = `${size * tracking}px`;
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.fillStyle = '#ffffff';

  // The glyphs are white and tinted by a uniform, so anything drawn here in
  // white takes the label's colour and anything drawn in black stays black
  // whatever that colour is. A black shadow therefore survives the tint, which
  // is what lets a readout carry its own contrast instead of needing a gradient
  // laid across the frame behind it.
  if (shadow > 0) {
    context.shadowColor = 'rgba(0, 0, 0, 0.9)';
    context.shadowBlur = size * shadow;
    // Twice, because one pass of a soft shadow is barely there against a bright
    // sky and the second costs nothing.
    context.fillText(text, PADDING + bleed, height / 2);
  }
  context.fillText(text, PADDING + bleed, height / 2);
  context.shadowBlur = 0;

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { texture, width, height, bleed };
}

/**
 * A single line of text as a flat mesh, laid out in pixels.
 *
 * The mesh is anchored by its alignment rather than its centre, so a right
 * aligned readout keeps its right edge fixed as the value changes width — which
 * matters when the number in it is a speed changing sixty times a second.
 */
export class TextMesh extends Mesh {
  private style: TextStyle;
  private pixelRatio: number;
  private currentText = '';
  private readonly tint = uniform(new Vector4(1, 1, 1, 1));
  private readonly opacity = uniform(1);
  private textureNodeHandle: ReturnType<typeof textureNode> | null = null;
  private canvasTexture: CanvasTexture | null = null;

  /** Rendered width and height in layout pixels. */
  readonly size = new Vector2();

  constructor(text: string, style: TextStyle = {}, pixelRatio = 2) {
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    super(new PlaneGeometry(1, 1), material);
    this.style = style;
    this.pixelRatio = pixelRatio;
    this.renderOrder = 10;
    this.setText(text);
  }

  get colourUniform(): typeof this.tint {
    return this.tint;
  }

  setColour(hex: number, alpha = 1): void {
    this.tint.value.set(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255, alpha);
  }

  setOpacity(value: number): void {
    this.opacity.value = value;
  }

  /** Re-renders only when the string actually changed. */
  setText(text: string): void {
    if (text === this.currentText && this.canvasTexture) return;
    this.currentText = text;

    this.canvasTexture?.dispose();
    const rendered = renderTextTexture(text, this.style, this.pixelRatio);
    this.canvasTexture = rendered.texture;
    // The reported size excludes the shadow's bleed. The plane still covers it,
    // so the blur is drawn, but layout and alignment are measured on the glyphs
    // — otherwise turning a halo on would quietly shove every readout inward by
    // half an em, which is exactly what it did the first time.
    this.size.set(rendered.width - rendered.bleed * 2, rendered.height - rendered.bleed * 2);

    this.geometry.dispose();
    this.geometry = new PlaneGeometry(rendered.width, rendered.height);

    const material = this.material as MeshBasicNodeMaterial;
    this.textureNodeHandle = textureNode(rendered.texture, uv());
    // The canvas is white glyphs on transparent; colour and fade come from
    // uniforms so a tint change costs nothing and never re-rasterises.
    material.colorNode = this.tint.xyz;
    material.opacityNode = this.textureNodeHandle.a.mul(this.tint.w).mul(this.opacity);
    material.needsUpdate = true;

    this.applyAlignment();
  }

  private applyAlignment(): void {
    const align = this.style.align ?? 'left';
    const half = this.size.x / 2;
    // PlaneGeometry is centred on its origin; shift it so the anchor is the
    // alignment edge instead.
    this.geometry.translate(align === 'left' ? half : align === 'right' ? -half : 0, 0, 0);
  }

  /** Restyles in place. Forces a re-render on the next `setText`. */
  restyle(style: TextStyle): void {
    this.style = { ...this.style, ...style };
    const text = this.currentText;
    this.currentText = '';
    this.setText(text);
  }

  setPixelRatio(ratio: number): void {
    if (Math.abs(ratio - this.pixelRatio) < 0.01) return;
    this.pixelRatio = ratio;
    const text = this.currentText;
    this.currentText = '';
    this.setText(text);
  }

  dispose(): void {
    this.canvasTexture?.dispose();
    this.geometry.dispose();
    (this.material as MeshBasicNodeMaterial).dispose();
  }
}

/** A flat coloured rectangle, for bars, rules and panels. */
export function panelMaterial(hex: number, alpha = 1): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.colorNode = color(hex);
  material.opacityNode = float(alpha);
  material.transparent = alpha < 1;
  material.depthTest = false;
  material.depthWrite = false;
  return material;
}
