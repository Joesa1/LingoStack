import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const rules = [
  ["OpenAI-style API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{20,}\b/g],
  ["AWS access key ID", /\bAKIA[0-9A-Z]{16}\b/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g],
  ["generic API-key assignment", /\b(?:api[_-]?(?:key|token)|client[_-]?secret|secret[_-]?key)\b\s*[:=]\s*["'`]([^"'`\s]{16,})["'`]/gi],
]

const placeholder = /^(?:fixture|test|example|sample|dummy|your|replace|changeme)[-_a-z0-9]*$/i
const text = file => {
  const data = readFileSync(file)
  return data.includes(0) ? null : data.toString("utf8")
}
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
  .toString("utf8").split("\0").filter(Boolean)
const findings = []

for (const file of paths) {
  const source = text(file)
  if (source === null) continue
  for (const [kind, pattern] of rules) {
    pattern.lastIndex = 0
    const match = pattern.exec(source)
    if (!match || (kind === "generic API-key assignment" && placeholder.test(match[1]))) continue
    findings.push({ file, kind })
  }
}

if (findings.length) {
  for (const { file, kind } of findings) console.error(`${file}: ${kind}`)
  process.exitCode = 1
} else {
  console.log(`Credential scan passed: ${paths.length} tracked files checked; no credential values printed.`)
}
