type WrapperIntegrityRecord = {
  expectedTextContent: string
  disabled: boolean
}

const integrityByWrapper = new WeakMap<Element, WrapperIntegrityRecord>()
const repairCountBySource = new WeakMap<Element, number>()

export const MAX_WRAPPER_TAMPER_REPAIRS = 3

export function recordCompletedBilingualWrapper(wrapper: Element): void {
  if (
    wrapper.getAttribute("data-lingo-tr-wrapper") !== "bilingual"
    || wrapper.getAttribute("data-lingo-tr-state") !== "done"
  ) {
    integrityByWrapper.delete(wrapper)
    return
  }
  integrityByWrapper.set(wrapper, {
    expectedTextContent: wrapper.textContent ?? "",
    disabled: false,
  })
}

export function clearWrapperIntegrity(wrapper: Element): void {
  integrityByWrapper.delete(wrapper)
}

export function isCompletedWrapperContentTampered(wrapper: Element): boolean {
  const record = integrityByWrapper.get(wrapper)
  return record !== undefined
    && !record.disabled
    && wrapper.getAttribute("data-lingo-tr-wrapper") === "bilingual"
    && wrapper.getAttribute("data-lingo-tr-state") === "done"
    && (wrapper.textContent ?? "") !== record.expectedTextContent
}

export function claimWrapperTamperRepair(source: Element): boolean {
  const current = repairCountBySource.get(source) ?? 0
  if (current >= MAX_WRAPPER_TAMPER_REPAIRS) return false
  repairCountBySource.set(source, current + 1)
  return true
}

export function stopWrapperIntegrityChecks(wrapper: Element): void {
  const record = integrityByWrapper.get(wrapper)
  if (record !== undefined) record.disabled = true
}

export function resetWrapperTamperRepairs(source: Element): void {
  repairCountBySource.delete(source)
}
