import type { SelectionContext, SelectionTranslateOptions } from "../shared/types"

const MAX_CONTEXT_SELECTION_CHARS = 120
export const MAX_SELECTION_CONTEXT_CHARS = 800
const CONTEXT_SIDE_CHARS = 300
const BLOCK_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, dd, dt, figcaption"
const SENTENCE_END_RE = /[.!?。！？]/

function elementFor(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

function semanticBlockFor(range: Range): Element | undefined {
  const start = elementFor(range.startContainer)
  const block = start?.closest(BLOCK_SELECTOR)
  if (block === null || block === undefined) return undefined
  const end = elementFor(range.endContainer)
  return end !== null && block.contains(end) ? block : undefined
}

function sentenceBounds(text: string, selectionStart: number, selectionEnd: number): { start: number; end: number } {
  let start = 0
  for (let index = selectionStart - 1; index >= 0; index--) {
    if (SENTENCE_END_RE.test(text[index] ?? "")) {
      start = index + 1
      break
    }
  }

  let end = text.length
  for (let index = selectionEnd; index < text.length; index++) {
    if (SENTENCE_END_RE.test(text[index] ?? "")) {
      end = index + 1
      break
    }
  }
  return { start, end }
}

function cappedBounds(textLength: number, selectionStart: number, selectionEnd: number): { start: number; end: number } {
  let start = Math.max(0, selectionStart - CONTEXT_SIDE_CHARS)
  let end = Math.min(textLength, selectionEnd + CONTEXT_SIDE_CHARS)
  const excess = end - start - MAX_SELECTION_CONTEXT_CHARS
  if (excess > 0) {
    const trimBefore = Math.min(Math.floor(excess / 2), selectionStart - start)
    start += trimBefore
    end -= excess - trimBefore
  }
  return { start, end }
}

function trimBounds(text: string, start: number, end: number, selectionStart: number, selectionEnd: number): { start: number; end: number } {
  while (start < selectionStart && /\s/.test(text[start] ?? "")) start += 1
  while (end > selectionEnd && /\s/.test(text[end - 1] ?? "")) end -= 1
  return { start, end }
}

/** Extract the selected sentence, falling back to a bounded window for very long blocks/sentences. */
export function extractSelectionContext(range: Range, selectedText: string): SelectionContext | undefined {
  if (selectedText.length === 0 || selectedText.length > MAX_CONTEXT_SELECTION_CHARS) return undefined
  const block = semanticBlockFor(range)
  if (block === undefined) return undefined

  const doc = block.ownerDocument
  const blockRange = doc.createRange()
  blockRange.selectNodeContents(block)
  const prefixRange = doc.createRange()
  prefixRange.selectNodeContents(block)
  try {
    prefixRange.setEnd(range.startContainer, range.startOffset)
  } catch {
    return undefined
  }

  const fullText = blockRange.toString()
  const rawSelected = range.toString()
  const leadingWhitespace = rawSelected.length - rawSelected.trimStart().length
  const selectionStart = prefixRange.toString().length + leadingWhitespace
  const selectionEnd = selectionStart + selectedText.length
  if (fullText.slice(selectionStart, selectionEnd) !== selectedText) return undefined

  let bounds = sentenceBounds(fullText, selectionStart, selectionEnd)
  if (bounds.end - bounds.start > MAX_SELECTION_CONTEXT_CHARS) {
    bounds = cappedBounds(fullText.length, selectionStart, selectionEnd)
  }
  bounds = trimBounds(fullText, bounds.start, bounds.end, selectionStart, selectionEnd)
  const contextText = fullText.slice(bounds.start, bounds.end)
  const adjustedStart = selectionStart - bounds.start
  const adjustedEnd = selectionEnd - bounds.start
  if (
    contextText.length === 0
    || contextText.length > MAX_SELECTION_CONTEXT_CHARS
    || contextText.slice(adjustedStart, adjustedEnd) !== selectedText
  ) {
    return undefined
  }
  return { text: contextText, selectionStart: adjustedStart, selectionEnd: adjustedEnd }
}

export function isDictionarySelection(text: string): boolean {
  if (text.length === 0 || text.length > 40 || /[\r\n.!?。！？;；:：]/.test(text)) return false
  return text.trim().split(/\s+/).length <= 5
}

export function selectionOptionsFor(range: Range, selectedText: string): SelectionTranslateOptions {
  const context = extractSelectionContext(range, selectedText)
  return {
    dictionary: isDictionarySelection(selectedText),
    ...(context !== undefined ? { context } : {}),
  }
}
