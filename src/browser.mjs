export * from './index.mjs';

let decodeContext = null;
/**
 * Decode a PNG to exact RGBA8 with the browser's native decoder. A 2D canvas
 * stores premultiplied alpha and loses the color of transparent pixels (the
 * console keeps it, and filtering blends it in), so the bitmap is decoded
 * unpremultiplied without color management, uploaded to a WebGL2 texture
 * as-is and read back.
 */
export async function decodePngBrowser(fileOrBlob) {
  const bmp = await createImageBitmap(fileOrBlob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  if (!decodeContext) {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    if (!gl) throw new Error('This editor requires WebGL 2');
    decodeContext = { gl, texture: gl.createTexture(), framebuffer: gl.createFramebuffer() };
  }
  const { gl, texture, framebuffer } = decodeContext, { width, height } = bmp;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
  bmp.close?.();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const data = new Uint8ClampedArray(width * height * 4);
  // Texture row 0 is the image's top row, and readPixels returns rows from row 0 up.
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { width, height, data };
}
export async function encodePngBrowser(image) {
  const c=document.createElement('canvas'); c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data),image.width,image.height),0,0);
  return await new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('PNG encoding failed')),'image/png'));
}
export function imageToCanvas(image,canvas){canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data),image.width,image.height),0,0);}
