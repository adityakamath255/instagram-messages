import type {
  Author,
  Conversation,
  InstagramArchive,
  Message,
} from "./archive.ts";

export const metrics = {
  Messages: (_message: Message) => 1,
  Characters: (message: Message) => [...(message.text ?? "")].length,
} satisfies Record<string, (message: Message) => number>;

export type Metric = keyof typeof metrics;

export interface Datum {
  readonly label: string;
  readonly value: number;
}

export interface ReactionDatum {
  readonly emoji: string;
  readonly self: number;
  readonly other: number;
}

export interface MessageReport {
  readonly byAuthor: Readonly<Record<Author, number>>;
  readonly byHour: readonly Datum[];
  readonly byWeekday: readonly Datum[];
  readonly daily: readonly Datum[];
  readonly reactions: readonly ReactionDatum[];
}

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function padded(value: number): string {
  return String(value).padStart(2, "0");
}

function dayOf(date: Date): string {
  return [
    date.getFullYear(),
    padded(date.getMonth() + 1),
    padded(date.getDate()),
  ].join("-");
}

function series(values: ReadonlyMap<string, number>): readonly Datum[] {
  return [...values]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, value]) => ({ label, value }));
}

function add(totals: Map<string, number>, key: string, value: number): void {
  totals.set(key, (totals.get(key) ?? 0) + value);
}

interface Cache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
}

function cached<K, V>(cache: Cache<K, V>, key: K, derive: () => V): V {
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const value = derive();
  cache.set(key, value);
  return value;
}

function monthly(daily: readonly Datum[]): readonly Datum[] {
  const totals = new Map<string, number>();
  for (const { label, value } of daily) {
    add(totals, label.slice(0, 7), value);
  }
  return series(totals);
}

function cumulative(daily: readonly Datum[]): readonly Datum[] {
  let running = 0;
  return daily.map(({ label, value }) => {
    running += value;
    return { label, value: running };
  });
}

export const trends = {
  Daily: (report: MessageReport) => report.daily,
  Monthly: (report: MessageReport) => monthly(report.daily),
  Cumulative: (report: MessageReport) => cumulative(report.daily),
} satisfies Record<string, (report: MessageReport) => readonly Datum[]>;

export type Trend = keyof typeof trends;

class MessageAnalyzer {
  readonly #metric: Metric;
  readonly #byAuthor: Record<Author, number> = { self: 0, other: 0 };
  readonly #hours = Array.from({ length: 24 }, () => 0);
  readonly #daysOfWeek = Array.from({ length: 7 }, () => 0);
  readonly #days = new Map<string, number>();
  readonly #reactions = new Map<
    string,
    { self: number; other: number }
  >();

  constructor(metric: Metric) {
    this.#metric = metric;
  }

  add(message: Message): number {
    const value = metrics[this.#metric](message);
    const date = new Date(message.timestamp);
    const weekday = (date.getDay() + 6) % 7;
    this.#byAuthor[message.author] += value;
    this.#hours[date.getHours()]! += value;
    this.#daysOfWeek[weekday]! += value;
    add(this.#days, dayOf(date), value);

    for (const reaction of message.reactions) {
      const count = this.#reactions.get(reaction.emoji) ?? {
        self: 0,
        other: 0,
      };
      count[reaction.actor] += 1;
      this.#reactions.set(reaction.emoji, count);
    }

    return value;
  }

  report(): MessageReport {
    const reactions = [...this.#reactions]
      .map(([emoji, counts]) => ({ emoji, ...counts }))
      .sort((left, right) =>
        right.self + right.other - left.self - left.other
      )
      .slice(0, 25);

    return {
      byAuthor: this.#byAuthor,
      byHour: this.#hours.map((value, hour) => ({
        label: padded(hour),
        value,
      })),
      byWeekday: this.#daysOfWeek.map((value, weekday) => ({
        label: weekdays[weekday]!,
        value,
      })),
      daily: series(this.#days),
      reactions,
    };
  }
}

export interface OverviewReport extends MessageReport {
  readonly conversationTotals: readonly Datum[];
}

function analyzeOverview(
  conversations: readonly Conversation[],
  metric: Metric,
): OverviewReport {
  const analyzer = new MessageAnalyzer(metric);
  const totals: Datum[] = [];

  for (const conversation of conversations) {
    let value = 0;
    for (const message of conversation.messages) {
      value += analyzer.add(message);
    }
    totals.push({ label: conversation.person, value });
  }

  totals.sort((left, right) => right.value - left.value);
  return {
    ...analyzer.report(),
    conversationTotals: totals.slice(0, 25),
  };
}

function analyzeMessages(
  messages: Iterable<Message>,
  metric: Metric,
): MessageReport {
  const analyzer = new MessageAnalyzer(metric);
  for (const message of messages) analyzer.add(message);
  return analyzer.report();
}

export class ArchiveAnalysis {
  readonly archive: InstagramArchive;
  readonly #overviews = new Map<Metric, OverviewReport>();
  readonly #conversationReports = new WeakMap<
    Conversation,
    Map<Metric, MessageReport>
  >();

  constructor(archive: InstagramArchive) {
    this.archive = archive;
  }

  conversation(
    conversation: Conversation,
    metric: Metric,
  ): MessageReport {
    const reports = cached(
      this.#conversationReports,
      conversation,
      () => new Map(),
    );
    return cached(reports, metric, () =>
      analyzeMessages(conversation.messages, metric));
  }

  overview(metric: Metric): OverviewReport {
    return cached(this.#overviews, metric, () =>
      analyzeOverview(this.archive.conversations, metric));
  }
}
