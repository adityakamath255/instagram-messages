import {
  BlobReader,
  TextWriter,
  ZipReader,
} from "@zip.js/zip.js";

export type Author = "self" | "other";

export interface Reaction {
  readonly emoji: string;
  readonly actor: Author;
}

export interface Message {
  readonly author: Author;
  readonly timestamp: number;
  readonly reactions: readonly Reaction[];
  readonly text: string | null;
}

export interface Conversation {
  readonly id: string;
  readonly person: string;
  readonly messages: readonly Message[];
}

export interface Follow {
  readonly username: string;
  readonly followedAt: number;
}

export interface ArchiveSource extends Blob {
  readonly name?: string;
}

export interface LoadProgress {
  readonly archive: number;
  readonly archives: number;
  readonly files: number;
}

export class ExportError extends Error {
  override readonly name = "ExportError";
}

export type FollowGroup = "mutual" | "you-follow" | "follows-you";

function indexFollows(follows: readonly Follow[]): ReadonlyMap<string, Follow> {
  const indexed = new Map<string, Follow>();
  for (const follow of follows) {
    const username = follow.username.toLowerCase();
    if (indexed.has(username)) {
      throw new ExportError(
        `The export contains more than one follow entry for @${follow.username}.`,
      );
    }
    indexed.set(username, follow);
  }
  return indexed;
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

type JsonObject = Record<string, unknown>;

const messageRoot = "your_instagram_activity/messages";
const followsRoot = "connections/followers_and_following";
const personalInfo =
  "personal_information/personal_information/personal_information.json";
const attachmentPlaceholder = " sent an attachment.";
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

function object(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${context} is not an object.`);
  }
  return value as JsonObject;
}

function array(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${context} is not a list.`);
  return value;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string") fail(`${context} is not text.`);
  return value;
}

function number(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${context} is not a number.`);
  }
  return value;
}

function parseJson(path: string, source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
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

function required(path: string): boolean {
  return (
    path === personalInfo ||
    path === `${followsRoot}/following.json` ||
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
    archives: archives.length,
    files: count,
  });

  for (const [archiveIndex, archive] of archives.entries()) {
    const reader = new ZipReader(new BlobReader(archive));
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        if (entry.directory) continue;
        const path = logicalPath(entry.filename);
        if (!path || !required(path)) continue;
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

function selfName(files: ReadonlyMap<string, string>): string {
  const root = object(
    parseJson(personalInfo, requiredFile(files, personalInfo)),
    personalInfo,
  );
  const profiles = array(root.profile_user, `${personalInfo}: profile_user`);
  const profile = object(profiles[0], `${personalInfo}: first profile`);
  const info = object(
    profile.string_map_data,
    `${personalInfo}: string_map_data`,
  );
  const field = info.Name ?? info.Username;
  const value = object(field, `${personalInfo}: Name or Username`).value;
  return decodeInstagramText(string(value, `${personalInfo}: profile name`));
}

function hasMedia(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function messageText(raw: JsonObject): string | null {
  if (
    raw.is_unsent ||
    raw.call_duration != null ||
    hasMedia(raw.audio_files) ||
    hasMedia(raw.photos) ||
    hasMedia(raw.videos)
  ) {
    return null;
  }
  const content = raw.content === undefined
    ? ""
    : string(raw.content, "message content");
  const decoded = decodeInstagramText(content);
  return decoded && !decoded.endsWith(attachmentPlaceholder) ? decoded : null;
}

function authorOf(value: unknown, me: string, context: string): Author {
  return decodeInstagramText(string(value, context)) === me ? "self" : "other";
}

function parseMessage(value: unknown, me: string): Message {
  const raw = object(value, "message");
  const reactions = raw.reactions === undefined
    ? []
    : array(raw.reactions, "message reactions");
  return {
    author: authorOf(raw.sender_name, me, "message sender"),
    timestamp: number(raw.timestamp_ms, "message timestamp"),
    reactions: reactions.map((value) => {
      const reaction = object(value, "reaction");
      return {
        emoji: decodeInstagramText(string(reaction.reaction, "reaction")),
        actor: authorOf(reaction.actor, me, "reaction actor"),
      };
    }),
    text: messageText(raw),
  };
}

interface RawThread {
  readonly participants: Set<string>;
  readonly messages: unknown[];
}

function conversations(
  files: ReadonlyMap<string, string>,
  me: string,
): readonly Conversation[] {
  const threads = new Map<string, RawThread>();

  for (const [path, source] of files) {
    const match = messageFile.exec(path);
    if (!match) continue;
    const id = `${match[1]}/${match[2]}`;
    const data = object(parseJson(path, source), path);
    const thread = threads.get(id) ?? {
      participants: new Set<string>(),
      messages: [],
    };
    for (const value of array(data.participants, `${path}: participants`)) {
      const participant = object(value, `${path}: participant`);
      thread.participants.add(
        decodeInstagramText(string(participant.name, `${path}: participant name`)),
      );
    }
    thread.messages.push(...array(data.messages, `${path}: messages`));
    threads.set(id, thread);
  }

  if (!threads.size) fail(`The export is missing ${messageRoot}.`);

  return [...threads].flatMap(([id, thread]) => {
    const others = [...thread.participants].filter((name) => name !== me);
    if (others.length !== 1) return [];
    const messages = thread.messages
      .map((message) => parseMessage(message, me))
      .sort((left, right) => left.timestamp - right.timestamp);
    return [{
      id,
      person: others[0]!,
      messages,
    }];
  });
}

function followName(entry: JsonObject, item: JsonObject): string {
  for (const candidate of [item.value, entry.title]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  const href = string(item.href, "follow profile link");
  const username = href.replace(/\/$/, "").split("/").at(-1);
  return username || fail("A follow entry has no username.");
}

function parseFollows(entries: readonly unknown[]): readonly Follow[] {
  return entries.flatMap((value) => {
    const entry = object(value, "follow entry");
    return array(entry.string_list_data, "follow entry data").map((value) => {
      const item = object(value, "follow data");
      return {
        username: followName(entry, item),
        followedAt: number(item.timestamp, "follow timestamp") * 1000,
      };
    });
  });
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
  const path = `${followsRoot}/following.json`;
  const data = object(parseJson(path, requiredFile(files, path)), path);
  return parseFollows(
    array(data.relationships_following, `${path}: relationships_following`),
  );
}

export class InstagramArchive {
  readonly sources: readonly string[];
  readonly conversations: readonly Conversation[];
  readonly follows: FollowNetwork;

  private constructor(
    sources: readonly string[],
    conversations: readonly Conversation[],
    follows: FollowNetwork,
  ) {
    this.sources = [...sources];
    this.conversations = conversations;
    this.follows = follows;
  }

  static async open(
    archives: readonly ArchiveSource[],
    onProgress?: (progress: LoadProgress) => void,
  ): Promise<InstagramArchive> {
    if (!archives.length) fail("Choose at least one Instagram export archive.");
    const files = await readArchives(archives, onProgress);
    const me = selfName(files);
    return new InstagramArchive(
      archives.map((archive, index) => archive.name || `Archive ${index + 1}`),
      conversations(files, me),
      new FollowNetwork(followerList(files), followingList(files)),
    );
  }

  get messageCount(): number {
    return this.conversations.reduce(
      (total, conversation) => total + conversation.messages.length,
      0,
    );
  }

  conversation(id: string): Conversation | undefined {
    return this.conversations.find((conversation) => conversation.id === id);
  }
}
