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

/** The image files among pasted or dropped items. */
export function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return []
  const files: (File | null)[] = list instanceof FileList ? Array.from(list) : Array.from(list as DataTransferItemList, (i) => (i.kind === 'file' ? i.getAsFile() : null))
  return files.filter((f): f is File => !!f && f.type.startsWith('image/'))
}
