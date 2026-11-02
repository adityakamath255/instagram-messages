import {
  BlobReader,
  TextWriter,
  ZipReader,
} from "@zip.js/zip.js";
import {
  analyzeConversations,
  type Author,
  type Conversation,
  type ConversationSummary,
  type Datum,
  type Message,
  type MessageAnalysis,
  type MessageReport,
  type ReactionDatum,
} from "./analysis.ts";

export {
  trends,
  type Author,
  type ConversationSummary,
  type MessageReport,
  type ReactionDatum,
  type Trend,
} from "./analysis.ts";

export interface Follow {
  readonly username: string;
  readonly followedAt: number;
}

export interface ArchiveSource extends Blob {
  readonly name?: string;
}

export interface LoadProgress {
  readonly archive: number;
  readonly files: number;
}

export class ExportError extends Error {
  override readonly name = "ExportError";
}

export type FollowGroup = "mutual" | "you-follow" | "follows-you";

function indexFollows(follows: readonly Follow[]): ReadonlyMap<string, Follow> {
  return new Map(follows.map((follow) =>
    [follow.username.toLowerCase(), follow] as const
  ));
}

export class FollowNetwork {
  readonly #followers: ReadonlyMap<string, Follow>;
  readonly #following: ReadonlyMap<string, Follow>;

  constructor(followers: readonly Follow[], following: readonly Follow[]) {
    this.#followers = indexFollows(followers);
    this.#following = indexFollows(following);
  }

  get followerCount(): number {
    return this.#followers.size;
  }

  get followingCount(): number {
    return this.#following.size;
  }

  group(group: FollowGroup): readonly Follow[] {
    switch (group) {
      case "mutual":
        return this.select(this.#following, (username) =>
          this.#followers.has(username)
        );
      case "you-follow":
        return this.select(this.#following, (username) =>
          !this.#followers.has(username)
        );
      case "follows-you":
        return this.select(this.#followers, (username) =>
          !this.#following.has(username)
        );
    }
  }

  private select(
    source: ReadonlyMap<string, Follow>,
    include: (username: string) => boolean,
  ): readonly Follow[] {
    return [...source]
      .filter(([username]) => include(username))
      .map(([, follow]) => follow);
  }
}

const messageRoot = "your_instagram_activity/messages";
const followsRoot = "connections/followers_and_following";
const followingFile = `${followsRoot}/following.json`;
const personalInfo =
  "personal_information/personal_information/personal_information.json";
const markers = [
  "your_instagram_activity/",
  "connections/",
  "personal_information/",
] as const;
const followerFile = new RegExp(`^${followsRoot}/followers_\\d+\\.json$`);
const messageFile = new RegExp(
  `^${messageRoot}/(inbox|message_requests)/(.+)/message_\\d+\\.json$`,
);

function fail(message: string): never {
  throw new ExportError(message);
}

function parseJson(path: string, source: string): any {
  try {
    return JSON.parse(source);
  } catch {
    return fail(`${path} does not contain valid JSON.`);
  }
}

function normalizedPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

function logicalPath(path: string): string | null {
  const normalized = normalizedPath(path);
  const lower = normalized.toLowerCase();
  const starts = markers
    .map((marker) => lower.indexOf(marker))
    .filter((index) => index === 0 || lower[index - 1] === "/");
  const start = Math.min(...starts);
  return Number.isFinite(start)
    ? normalized.slice(start).toLowerCase()
    : null;
}

function supported(path: string): boolean {
  return (
    path === personalInfo ||
    path === followingFile ||
    followerFile.test(path) ||
    messageFile.test(path)
  );
}

async function readArchives(
  archives: readonly ArchiveSource[],
  onProgress?: (progress: LoadProgress) => void,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let count = 0;
  const report = (archive: number) => onProgress?.({
    archive,
    files: count,
  });

  for (const [archiveIndex, archive] of archives.entries()) {
    const reader = new ZipReader(new BlobReader(archive));
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        if (entry.directory) continue;
        const path = logicalPath(entry.filename);
        if (!path || !supported(path)) continue;
        const source = await entry.getData(new TextWriter());
        const previous = files.get(path);
        if (previous !== undefined && previous !== source) {
          fail(`The selected archives contain conflicting copies of ${path}.`);
        }
        files.set(path, source);
        count += 1;
        if (count === 1 || count % 20 === 0) {
          report(archiveIndex + 1);
        }
      }
    } finally {
      await reader.close();
    }
    report(archiveIndex + 1);
  }

  if (!count) {
    fail("No supported Instagram JSON files were found in those archives.");
  }
  return files;
}

function requiredFile(files: ReadonlyMap<string, string>, path: string): string {
  const source = files.get(path);
  if (source === undefined) fail(`The export is missing ${path}.`);
  return source;
}

export function decodeInstagramText(value: string): string {
  if ([...value].some((character) => character.codePointAt(0)! > 255)) {
    return value;
  }
  try {
    const bytes = Uint8Array.from(value, (character) =>
      character.codePointAt(0)!,
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

function selfName(source: string): string {
  const root = parseJson(personalInfo, source);
  const info = root.profile_user[0]?.string_map_data;
  const name = info?.Name?.value ?? info?.Username?.value;
  return name
    ? decodeInstagramText(name)
    : fail(`${personalInfo} has no profile name.`);
}

function authorOf(name: string, me: string): Author {
  return decodeInstagramText(name) === me ? "self" : "other";
}

function parseMessage(raw: any, me: string): Message {
  return {
    author: authorOf(raw.sender_name, me),
    timestamp: raw.timestamp_ms,
    reactions: (raw.reactions ?? []).map((reaction: any) => ({
      emoji: decodeInstagramText(reaction.reaction),
      actor: authorOf(reaction.actor, me),
    })),
  };
}

function* parsedMessages(
  messages: readonly any[],
  me: string,
): Iterable<Message> {
  for (const message of messages) yield parseMessage(message, me);
}

function* conversations(
  files: ReadonlyMap<string, string>,
): Iterable<Conversation> {
  const me = selfName(requiredFile(files, personalInfo));
  const threads = new Map<
    string,
    { participants: Set<string>; messages: any[] }
  >();

  for (const [path, source] of files) {
    const match = messageFile.exec(path);
    if (!match) continue;
    const id = `${match[1]}/${match[2]}`;
    const data = parseJson(path, source);
    const thread = threads.get(id) ?? {
      participants: new Set<string>(),
      messages: [],
    };
    for (const participant of data.participants) {
      thread.participants.add(
        decodeInstagramText(participant.name),
      );
    }
    thread.messages.push(...data.messages);
    threads.set(id, thread);
  }

  for (const [id, thread] of threads) {
    const others = [...thread.participants].filter((name) => name !== me);
    if (others.length !== 1) continue;
    yield {
      id,
      person: others[0]!,
      messages: parsedMessages(thread.messages, me),
    };
  }
}

function followName(entry: any, item: any): string {
  for (const candidate of [item.value, entry.title]) {
    if (candidate) return candidate;
  }
  const username = item.href?.replace(/\/$/, "").split("/").at(-1);
  return username || fail("A follow entry has no username.");
}

function parseFollows(entries: readonly any[]): readonly Follow[] {
  return entries.flatMap((entry) =>
    entry.string_list_data.map((item: any) => ({
      username: followName(entry, item),
      followedAt: item.timestamp * 1000,
    }))
  );
}

function followerList(files: ReadonlyMap<string, string>): readonly Follow[] {
  const paths = [...files].filter(([path]) => followerFile.test(path));
  if (!paths.length) fail(`The export is missing ${followsRoot}/followers_1.json.`);
  return parseFollows(paths.flatMap(([path, source]) => {
    const data = parseJson(path, source);
    return Array.isArray(data) ? data : [data];
  }));
}

function followingList(files: ReadonlyMap<string, string>): readonly Follow[] {
  const data = parseJson(followingFile, requiredFile(files, followingFile));
  return parseFollows(data.relationships_following);
}

function followNetwork(files: ReadonlyMap<string, string>): FollowNetwork | null {
  const hasFollows = [...files.keys()].some((path) =>
    path === followingFile || followerFile.test(path)
  );
  return hasFollows
    ? new FollowNetwork(followerList(files), followingList(files))
    : null;
}

export class InstagramArchive {
  readonly sources: readonly string[];
  readonly hasMessages: boolean;
  readonly messageCount: number;
  readonly conversations: readonly ConversationSummary[];
  readonly follows: FollowNetwork | null;
  readonly #analysis: MessageAnalysis;

  private constructor(
    sources: readonly string[],
    hasMessages: boolean,
    analysis: MessageAnalysis,
    follows: FollowNetwork | null,
  ) {
    this.sources = [...sources];
    this.hasMessages = hasMessages;
    this.follows = follows;
    this.#analysis = analysis;
    this.conversations = analysis.conversations;
    this.messageCount = this.conversations.reduce(
      (total, conversation) => total + conversation.messageCount,
      0,
    );
  }

  static async open(
    archives: readonly ArchiveSource[],
    onProgress?: (progress: LoadProgress) => void,
  ): Promise<InstagramArchive> {
    if (!archives.length) fail("Choose at least one Instagram export archive.");
    const files = await readArchives(archives, onProgress);
    const hasMessages = [...files.keys()].some((path) => messageFile.test(path));
    const follows = followNetwork(files);
    if (!hasMessages && !follows) {
      fail("The export contains neither messages nor follow data.");
    }
    const analysis = analyzeConversations(
      hasMessages ? conversations(files) : [],
    );
    return new InstagramArchive(
      archives.map((archive, index) => archive.name || `Archive ${index + 1}`),
      hasMessages,
      analysis,
      follows,
    );
  }

  conversation(id: string): ConversationSummary | undefined {
    return this.conversations.find((conversation) => conversation.id === id);
  }

  get overview(): MessageReport {
    return this.#analysis.overview;
  }

  get conversationTotals(): readonly Datum[] {
    return this.#analysis.conversationTotals;
  }

  get reactions(): readonly ReactionDatum[] {
    return this.#analysis.reactions;
  }
}
