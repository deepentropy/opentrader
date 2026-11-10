/*
 * The evaluation memory of the alert rules, one object per rule, kept while
 * the rule's signature stays the same: as the backend's engine does
 * (engine.rs, `EngineRule::sig`), an edited, restarted or deleted rule starts
 * again from its next sample without anyone having to say so. The signature
 * holds what the condition reads (the points and style of the drawing it
 * compares with included: a moved line is a new level) and when the rule became
 * active (an edit or a restart moves `activeSince`). The rules handed to the
 * backend are signed by the same function (alert-backend.ts), so the window and
 * the backend forget a rule's memory on the same changes.
 */
import { conditionRules } from "./alert-condition";
import type { AlertRule } from "./alert-store";
import { newRuleState, type RuleState } from "./alert-eval";
import type { StrategyAlertState } from "./alert-strategy";
import type { StrategyAlertRun } from "./alert-strategies";
import { loadDrawings } from "../window/drawings/persistence";

/** What one condition's memory depends on: the condition, and the points and style of the drawing it compares with
 *  (as saved). */
export function conditionSignature(c: AlertRule): unknown[] {
  const right = c.right;
  const drawing = right.kind === "drawing" ? loadDrawings(c.symbol).find((d) => d.id === right.drawingId) : undefined;
  return [c.op, c.left, c.right, c.right2, c.resolution, c.bars, drawing?.points, drawing?.style];
}

/** The signature of a rule: changes whenever its condition, the drawing it reads, its trigger, its session or the
 *  moment it became active changes. */
export function ruleSignature(rule: AlertRule): string {
  // Older rules without a session: regular hours, a chart's default.
  return JSON.stringify([rule.frequency, rule.session ?? "RTH", rule.activeSince ?? rule.createdAt, ...conditionRules(rule).map(conditionSignature)]);
}

/** One state object per rule, made by `create`, kept while the rule stays listed with the same signature. */
export class RuleStates<T> {
  private states = new Map<string, { sig: string; state: T }>();
  private sigs = new Map<string, string>();

  constructor(private create: () => T) {}

  /** The rules to keep memory for, with their signatures: the others lose theirs, as does a rule whose signature
   *  changed. */
  sync(sigs: Map<string, string>): void {
    this.sigs = new Map(sigs);
    for (const [id, s] of this.states) if (sigs.get(id) !== s.sig) this.states.delete(id);
  }

  /** Rule `id`'s signature read again between two syncs (a drawing moves without the rules changing): its memory is
   *  dropped at the next `get` when the signature differs. A rule that is not synced stays out. */
  resign(id: string, sig: string): void {
    if (this.sigs.has(id)) this.sigs.set(id, sig);
  }

  /** The state of rule `id` (a new one the first time, or after its signature changed). */
  get(id: string): T {
    const sig = this.sigs.get(id) ?? "";
    let s = this.states.get(id);
    if (!s || s.sig !== sig) this.states.set(id, (s = { sig, state: this.create() }));
    return s.state;
  }

  /** The state of rule `id` when it has one. */
  peek(id: string): T | undefined {
    return this.states.get(id)?.state;
  }

  get size(): number {
    return this.states.size;
  }
}

/** What a rule evaluated in the window remembers between two reads. */
export type RuleRuntime = {
  /** The evaluation's memory (previous sample, last fire, forming bar…), its other conditions' included. */
  eval: RuleState;
  /** Moving conditions: the value N bars back, per condition (0: the first one); unset until fetched. */
  movingRefs: (number | null)[];
  /** A script's alert() calls: the newest bar seen (its time in the study's bars), whether a once-per-bar call fired
   *  in it, the last run read (each run's calls are read once). */
  calls: { bar: number; once: boolean; seq: number } | null;
  /** A strategy: the fills already seen, its latest run and the fills delivered. */
  strategy: StrategyAlertState | null;
  strategyRun: { sig: string; at: number; value: StrategyAlertRun | null } | null;
  strategyDelivered: Set<string>;
};

/** The memory of the rules the window evaluates. */
export const ruleRuntimes = new RuleStates<RuleRuntime>(() => ({ eval: newRuleState(), movingRefs: [], calls: null, strategy: null, strategyRun: null, strategyDelivered: new Set() }));
