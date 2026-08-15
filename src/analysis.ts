export const metrics = ["Messages", "Characters"] as const;

export type Metric = typeof metrics[number];
export type Author = "self" | "other";

export interface Reaction {
  readonly emoji: string;
  readonly actor: Author;
}

export interface Message {
  readonly author: Author;
  readonly timestamp: number;
  readonly characters: number;
  readonly reactions: readonly Reaction[];
}

export interface Conversation {
  readonly id: string;
  readonly person: string;
  readonly messages: Iterable<Message>;
}

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
}

export interface OverviewReport extends MessageReport {
  readonly conversationTotals: readonly Datum[];
}

export interface ConversationSummary {
  readonly id: string;
  readonly person: string;
  readonly messageCount: number;
  readonly report: (metric: Metric) => MessageReport;
  readonly reactions: () => readonly ReactionDatum[];
}

export interface MessageAnalysis {
  readonly conversations: readonly ConversationSummary[];
  readonly overview: (metric: Metric) => OverviewReport;
  readonly reactions: () => readonly ReactionDatum[];
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

function monthly(daily: readonly Datum[]): readonly Datum[] {
  const totals = new Map<string, number>();
  for (const { label, value } of daily) {
    const month = label.slice(0, 7);
    totals.set(month, (totals.get(month) ?? 0) + value);
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

type Counts = Record<Metric, number>;

interface Aggregate {
  readonly byAuthor: Record<Author, Counts>;
  readonly byHour: Counts[];
  readonly byWeekday: Counts[];
  readonly daily: Map<string, Counts>;
  readonly reactions: Map<string, Record<Author, number>>;
}

function emptyCounts(): Counts {
  return { Messages: 0, Characters: 0 };
}

function emptyAggregate(): Aggregate {
  return {
    byAuthor: { self: emptyCounts(), other: emptyCounts() },
    byHour: Array.from({ length: 24 }, emptyCounts),
    byWeekday: Array.from({ length: 7 }, emptyCounts),
    daily: new Map(),
    reactions: new Map(),
  };
}

function addCounts(target: Counts, messages: number, characters: number): void {
  target.Messages += messages;
  target.Characters += characters;
}

function mergeCounts(target: Counts, source: Counts): void {
  addCounts(target, source.Messages, source.Characters);
}

function addMessage(aggregate: Aggregate, message: Message): void {
  const date = new Date(message.timestamp);
  const weekday = (date.getDay() + 6) % 7;
  addCounts(aggregate.byAuthor[message.author], 1, message.characters);
  addCounts(aggregate.byHour[date.getHours()]!, 1, message.characters);
  addCounts(aggregate.byWeekday[weekday]!, 1, message.characters);

  const day = dayOf(date);
  const daily = aggregate.daily.get(day) ?? emptyCounts();
  addCounts(daily, 1, message.characters);
  aggregate.daily.set(day, daily);

  for (const reaction of message.reactions) {
    const counts = aggregate.reactions.get(reaction.emoji) ?? {
      self: 0,
      other: 0,
    };
    counts[reaction.actor] += 1;
    aggregate.reactions.set(reaction.emoji, counts);
  }
}

function mergeAggregate(target: Aggregate, source: Aggregate): void {
  mergeCounts(target.byAuthor.self, source.byAuthor.self);
  mergeCounts(target.byAuthor.other, source.byAuthor.other);
  for (let hour = 0; hour < 24; hour += 1) {
    mergeCounts(target.byHour[hour]!, source.byHour[hour]!);
  }
  for (let weekday = 0; weekday < 7; weekday += 1) {
    mergeCounts(target.byWeekday[weekday]!, source.byWeekday[weekday]!);
  }
  for (const [day, sourceCounts] of source.daily) {
    const counts = target.daily.get(day) ?? emptyCounts();
    mergeCounts(counts, sourceCounts);
    target.daily.set(day, counts);
  }
  for (const [emoji, sourceCounts] of source.reactions) {
    const counts = target.reactions.get(emoji) ?? { self: 0, other: 0 };
    counts.self += sourceCounts.self;
    counts.other += sourceCounts.other;
    target.reactions.set(emoji, counts);
  }
}

function series(values: ReadonlyMap<string, number>): readonly Datum[] {
  return [...values]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, value]) => ({ label, value }));
}

function countSeries(
  values: ReadonlyMap<string, Counts>,
  metric: Metric,
): readonly Datum[] {
  return [...values]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, counts]) => ({ label, value: counts[metric] }));
}

function report(aggregate: Aggregate, metric: Metric): MessageReport {
  return {
    byAuthor: {
      self: aggregate.byAuthor.self[metric],
      other: aggregate.byAuthor.other[metric],
    },
    byHour: aggregate.byHour.map((counts, hour) => ({
      label: padded(hour),
      value: counts[metric],
    })),
    byWeekday: aggregate.byWeekday.map((counts, weekday) => ({
      label: weekdays[weekday]!,
      value: counts[metric],
    })),
    daily: countSeries(aggregate.daily, metric),
  };
}

function reports(aggregate: Aggregate): Record<Metric, MessageReport> {
  return {
    Messages: report(aggregate, "Messages"),
    Characters: report(aggregate, "Characters"),
  };
}

function reactions(aggregate: Aggregate): readonly ReactionDatum[] {
  return [...aggregate.reactions]
    .map(([emoji, counts]) => ({ emoji, ...counts }))
    .sort((left, right) =>
      right.self + right.other - left.self - left.other ||
      left.emoji.localeCompare(right.emoji)
    )
    .slice(0, 25);
}

function total(aggregate: Aggregate, metric: Metric): number {
  return aggregate.byAuthor.self[metric] + aggregate.byAuthor.other[metric];
}

function overviewReport(
  aggregate: Aggregate,
  metric: Metric,
  conversations: readonly ConversationSummary[],
): OverviewReport {
  return {
    ...report(aggregate, metric),
    conversationTotals: conversations
      .map((conversation) => {
        const report = conversation.report(metric);
        return {
          label: conversation.person,
          value: report.byAuthor.self + report.byAuthor.other,
        };
      })
      .sort((left, right) => right.value - left.value)
      .slice(0, 25),
  };
}

export function analyzeConversations(
  inputs: Iterable<Conversation>,
): MessageAnalysis {
  const overview = emptyAggregate();
  const conversations: ConversationSummary[] = [];

  for (const input of inputs) {
    const aggregate = emptyAggregate();
    for (const message of input.messages) addMessage(aggregate, message);
    mergeAggregate(overview, aggregate);
    const conversationReports = reports(aggregate);
    const conversationReactions = reactions(aggregate);
    conversations.push({
      id: input.id,
      person: input.person,
      messageCount: total(aggregate, "Messages"),
      report: (metric) => conversationReports[metric],
      reactions: () => conversationReactions,
    });
  }

  const overviewReports: Record<Metric, OverviewReport> = {
    Messages: overviewReport(overview, "Messages", conversations),
    Characters: overviewReport(overview, "Characters", conversations),
  };
  const overviewReactions = reactions(overview);
  return {
    conversations,
    overview: (metric) => overviewReports[metric],
    reactions: () => overviewReactions,
  };
}
