/** Images you attach to a message: shrunk so the longest side is at most 1568 px (what Claude reads at full detail). */

export const MAX_IMAGES = 6
const MAX_SIDE = 1568
const MAX_BYTES = 3_700_000

const readAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read the image.'))
    r.readAsDataURL(blob)
  })

/** A picked, pasted or dropped image file as a PNG or JPEG data URL, scaled down when it's big. */
export async function prepareImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Only PNG, JPEG, GIF and WebP images can be attached.')
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.size <= MAX_BYTES) {
    bitmap.close()
    return readAsDataUrl(file)
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const png = file.type === 'image/png' ? canvas.toDataURL('image/png') : ''
  return png && png.length * 0.75 <= MAX_BYTES ? png : canvas.toDataURL('image/jpeg', 0.88)
}

const PREVIEW_SIDE = 480

/** A small JPEG of an attached image, kept with your message in the chat (the full image is removed once it's sent). */
export async function previewOf(dataUrl: string): Promise<string> {
  // Loaded as an <img> (the window's rules allow data: images, not fetching them).
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const bitmap = await createImageBitmap(img)
  const scale = Math.min(1, PREVIEW_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')!
  // JPEG has no transparency: a see-through PNG goes on white instead of black.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.75)
}

/** Only previews Hangar made are shown: small PNG or JPEG data URLs. */
export const isPreview = (src: unknown): src is string => typeof src === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(src)

/** The image files among pasted or dropped items. */
export function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return []
  const files: (File | null)[] = list instanceof FileList ? Array.from(list) : Array.from(list as DataTransferItemList, (i) => (i.kind === 'file' ? i.getAsFile() : null))
  return files.filter((f): f is File => !!f && f.type.startsWith('image/'))
}
