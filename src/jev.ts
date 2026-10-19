import { z } from "zod";

// Chooser and tournament follow pi-browse's jev.ts; only the question and candidate source differ.
export const JEV_MODEL = "typesafe-ai/jev";
const JEV_URL = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";
/** Small chunks are cheaper and fail less often at the gateway: 32 options plus NONE is ~1.8k tokens. */
const CHUNK = 32;
/** A request still unanswered after this long gets a duplicate; the first valid answer wins. */
const HEDGE_MS = 1_500;
const MAX_COPIES = 5;
const NONE = "none";
export const JEV_MIN_CONFIDENCE = 0.5;

const TEXT_ENTRY = new Set(["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]);
const SCROLLABLE = new Set(["AXScrollArea", "AXList", "AXTable", "AXOutline", "AXWebArea", "AXTextArea", "AXBrowser", "AXCollection"]);
const PRESSABLE = new Set(["AXPress", "AXOpen", "AXConfirm", "AXPick", "AXShowMenu", "AXIncrement", "AXDecrement"]);
/** Labels Jev may locate but not act on; the agent must pass the index to confirm. */
export const DESTRUCTIVE = /\b(delete|remove|erase|trash|send|buy|purchase|pay|checkout|transfer|discard|uninstall|format|sign out|log ?out)\b/i;

const answerSchema = z.object({
  answers: z.object({
    target: z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), z.number()), confidence: z.number() }),
  }),
});

/** Refusals that no retry fixes; the user has to act on the gateway account or key. */
export function gatewayRefusal(status: number): string {
  if (status === 402) return "Vercel AI Gateway refused Jev with HTTP 402: the gateway account is out of credits or needs billing. JEV is unusable until the user fixes that.";
  if (status === 401 || status === 403) return `Vercel AI Gateway rejected the Jev key (HTTP ${status}). The user must replace the configured AI Gateway key.`;
  return `Jev request failed with HTTP ${status}.`;
}

export type ChoiceAnswer = z.infer<typeof answerSchema>["answers"]["target"];
export interface Candidate { ref: string; label: string; role: string; text: string }
export interface RankedCandidate extends Candidate { probability: number }
export interface JevState { app: string; window: string; action: string; request: string }
export type Choose = (state: JevState, criteria: Record<string, string>, signal?: AbortSignal) => Promise<ChoiceAnswer>;
/** `none`: Jev's answer was that no listed element matches, as opposed to being unsure among candidates. */
export interface JevPick { chosen?: Candidate; none: boolean; confidence: number; ranked: RankedCandidate[] }
type Attempt = { kind: "answer"; answer: ChoiceAnswer } | { kind: "transient"; status?: number } | { kind: "fatal"; message: string };
interface ElementInfo { role?: string; label?: string; actions?: string[]; enabled?: boolean; parent_index?: number }

function fits(op: string, element: ElementInfo): boolean {
  const role = element.role ?? "";
  if (op === "type") return TEXT_ENTRY.has(role);
  if (op === "set_value") return TEXT_ENTRY.has(role) || role === "AXSlider";
  if (op === "scroll") return SCROLLABLE.has(role);
  return TEXT_ENTRY.has(role) || (element.actions ?? []).some(action => PRESSABLE.has(action));
}

/**
 * Candidates for `op`: line text from cua's tree_markdown, role/label/actions/ancestry from the structured elements.
 * Leaves out the menu bar (the menu op covers it), secure fields, disabled controls, and typed text-field values;
 * unnamed rows and cells borrow their visible child text, and every label carries two named ancestors.
 */
export function desktopCandidates(tree: string, elements: unknown[], op: string): Candidate[] {
  const info = new Map<number, ElementInfo>();
  for (const element of elements as any[]) if (typeof element?.element_index === "number") info.set(element.element_index, element);
  const lines = new Map<number, { text: string; texts: string[] }>();
  const stack: { depth: number; index: number }[] = [];
  for (const line of tree.split("\n")) {
    const match = /^(\s*)- (?:\[(\d+)\] )?(.+)$/.exec(line);
    if (!match) continue;
    const depth = match[1]!.length;
    while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
    if (match[2] === undefined) {
      const words = /"((?:[^"\\]|\\.)*)"/.exec(match[3]!)?.[1];
      const owner = stack.at(-1) && lines.get(stack.at(-1)!.index);
      if (words && owner && owner.texts.length < 3) owner.texts.push(words.slice(0, 60));
      continue;
    }
    const index = Number(match[2]);
    const role = info.get(index)?.role ?? "";
    let text = match[3]!.replace(/\s*actions=\[[^\]]*\]/, "").replace(/\s*id=_NS:\d+/, "").replace(/\s*\[\]$/, "");
    if (TEXT_ENTRY.has(role)) text = text.replace(/\s=\s"(?:[^"\\]|\\.)*"/, "");
    lines.set(index, { text: text.slice(0, 160), texts: [] });
    stack.push({ depth, index });
  }
  const name = (index: number): string | undefined => {
    const line = lines.get(index);
    const label = info.get(index)?.label;
    if (!line) return undefined;
    if (/["(]/.test(line.text)) return line.text;
    if (label) return `${line.text} "${label.slice(0, 80)}"`;
    return line.texts.length ? `${line.text} text "${line.texts.join(" / ")}"` : undefined;
  };
  const ancestors = (index: number) => {
    const chain: number[] = [];
    for (let parent = info.get(index)?.parent_index; parent !== undefined && chain.length < 40; parent = info.get(parent)?.parent_index) chain.push(parent);
    return chain;
  };
  return [...lines.keys()].flatMap(index => {
    const element = info.get(index) ?? {};
    const chain = ancestors(index);
    if (element.role === "AXMenuBar" || chain.some(parent => info.get(parent)?.role === "AXMenuBar")) return [];
    if (element.role === "AXSecureTextField" || element.enabled === false || !fits(op, element)) return [];
    const text = name(index) ?? lines.get(index)!.text;
    const context = chain.filter(parent => info.get(parent)?.role !== "AXWindow").flatMap(parent => name(parent)?.slice(0, 60) ?? []).slice(0, 2).reverse();
    const label = context.length ? `${text} (in ${context.join(" > ")})` : text;
    return [{ ref: String(index), label: label.slice(0, 240), role: element.role ?? "", text }];
  });
}

/** Tournament over Jev's per-choice option limit; the final round decides whether the pick is confident enough to act. */
export async function pickTarget(candidates: Candidate[], state: JevState, choose: Choose, signal?: AbortSignal): Promise<JevPick> {
  let pool = candidates;
  for (;;) {
    const chunks: Candidate[][] = [];
    for (let i = 0; i < pool.length; i += CHUNK) chunks.push(pool.slice(i, i + CHUNK));
    const answers = await Promise.all(chunks.map(chunk => choose(state, {
      ...Object.fromEntries(chunk.map(c => [c.ref, c.label])),
      [NONE]: "No listed element matches the request.",
    }, signal)));
    if (chunks.length === 1) {
      const [answer] = answers as [ChoiceAnswer];
      const ranked = pool.map(c => ({ ...c, probability: answer.probabilities[c.ref] ?? 0 }))
        .sort((a, b) => b.probability - a.probability).slice(0, 5);
      const chosen = answer.confidence >= JEV_MIN_CONFIDENCE ? pool.find(c => c.ref === answer.choice) : undefined;
      return { chosen, none: answer.choice === NONE && answer.confidence >= JEV_MIN_CONFIDENCE, confidence: answer.confidence, ranked };
    }
    const won = answers.flatMap((answer, i) => chunks[i]!.filter(c => c.ref === answer.choice).map(chosen => ({ chosen, confidence: answer.confidence })));
    if (!won.length) return { none: true, confidence: Math.min(...answers.map(a => a.confidence)), ranked: [] };
    // A lone confident winner would face only itself in another round; take it without the extra request.
    if (won.length === 1 && won[0]!.confidence >= JEV_MIN_CONFIDENCE) return { ...won[0]!, none: false, ranked: [] };
    pool = won.map(w => w.chosen);
  }
}

/**
 * One System One choice through Vercel AI Gateway's TypeSafe-compatible endpoint, hedged: a copy starts every
 * `hedgeMs` without an answer, and after every started copy failed transiently another starts after 0-250 ms,
 * up to five copies. The first valid answer wins and aborts the rest.
 */
export function jevChooser(apiKey: string, hedgeMs = HEDGE_MS): Choose {
  return (state, criteria, signal) => {
    const body = JSON.stringify({
      model: JEV_MODEL, state,
      questions: { target: { type: "choice", instructions: "Which listed control in this macOS app window should the desktop `action` be performed on to satisfy `request`?", criteria } },
    });
    const attempt = async (copy: AbortSignal): Promise<Attempt> => {
      let response: Response;
      try { response = await fetch(JEV_URL, { method: "POST", signal: copy, body, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }); }
      catch { return { kind: "transient" }; }
      // Upstream bodies are not echoed: they can carry request echoes.
      if (!response.ok) {
        const transient = response.status === 408 || response.status === 429 || response.status >= 500;
        return transient ? { kind: "transient", status: response.status } : { kind: "fatal", message: gatewayRefusal(response.status) };
      }
      const parsed = answerSchema.safeParse(await response.json().catch(() => undefined));
      return parsed.success ? { kind: "answer", answer: parsed.data.answers.target } : { kind: "fatal", message: "Jev returned an unexpected response." };
    };
    return new Promise<ChoiceAnswer>((resolve, reject) => {
      signal?.throwIfAborted();
      const copies = new Set<AbortController>();
      let started = 0;
      let lastStatus: number | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (settle: () => void) => {
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        for (const copy of copies) copy.abort();
        settle();
      };
      const onAbort = () => finish(() => reject(signal!.reason));
      const launch = () => {
        started++;
        const copy = new AbortController();
        copies.add(copy);
        clearTimeout(timer);
        timer = started < MAX_COPIES ? setTimeout(launch, hedgeMs) : undefined;
        void attempt(copy.signal).then(result => {
          copies.delete(copy);
          if (done) return;
          if (result.kind === "answer") return finish(() => resolve(result.answer));
          if (result.kind === "fatal") return finish(() => reject(new Error(result.message)));
          lastStatus = result.status ?? lastStatus;
          if (copies.size) return;
          if (started >= MAX_COPIES) {
            return finish(() => reject(new Error(lastStatus ? `Jev request failed with HTTP ${lastStatus}.` : "Jev request failed with a network error.")));
          }
          clearTimeout(timer);
          timer = setTimeout(launch, Math.random() * 250);
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      launch();
    });
  };
}
