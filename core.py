import json
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone, tzinfo
from itertools import accumulate
from pathlib import Path
from typing import Literal, TypeVar


def decode(s: str) -> str:
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


Author = Literal["self", "other"]
MediaKind = Literal["photo", "video"]


@dataclass(frozen=True)
class MediaItem:
    kind: MediaKind
    uri: str


@dataclass(frozen=True)
class Media:
    items: Sequence[MediaItem]


@dataclass(frozen=True)
class Audio:
    uri: str


@dataclass(frozen=True)
class Shared:
    link: str | None
    description: str


@dataclass(frozen=True)
class Text:
    text: str


@dataclass(frozen=True)
class Call:
    duration_s: int


@dataclass(frozen=True)
class Unsent: ...


@dataclass(frozen=True)
class Unknown: ...


Body = Text | Media | Audio | Shared | Call | Unsent | Unknown


@dataclass(frozen=True)
class Reaction:
    emoji: str
    actor: Author


@dataclass(frozen=True)
class Message:
    author: Author
    timestamp: datetime
    reactions: Sequence[Reaction]
    body: Body


@dataclass(frozen=True)
class Chat:
    person: str
    messages: Sequence[Message]


PLACEHOLDER = "sent an attachment."
MEDIA_KEYS: tuple[tuple[MediaKind, str], ...] = (
    ("photo", "photos"), ("video", "videos")
)


def media_items(raw: dict) -> list[MediaItem]:
    return [
        MediaItem(kind, item["uri"])
        for kind, key in MEDIA_KEYS
        for item in raw.get(key, [])
    ]


def parse_body(raw: dict) -> Body:
    if raw.get("is_unsent"):
        return Unsent()
    if "call_duration" in raw:
        return Call(raw["call_duration"])
    if "audio_files" in raw:
        return Audio(raw["audio_files"][0]["uri"])

    items = media_items(raw)
    if items:
        return Media(items)

    content = decode(raw.get("content", ""))
    typed = "" if content.endswith(PLACEHOLDER) else content

    if typed:
        return Text(typed)
    if share := raw.get("share"):
        return Shared(share.get("link"), decode(share.get("share_text", "")))
    return Unknown()


def author_of(name: str, me: str) -> Author:
    return "self" if decode(name) == me else "other"


def parse_message(raw: dict, me: str) -> Message:
    return Message(
        author=author_of(raw["sender_name"], me),
        timestamp=datetime.fromtimestamp(
            raw["timestamp_ms"] / 1000,
            tz=timezone.utc
        ),
        reactions=[
            Reaction(decode(r["reaction"]), author_of(r["actor"], me))
            for r in raw.get("reactions", [])
        ],
        body=parse_body(raw),
    )


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def self_name(export: Path) -> str:
    data = read_json(
        export / "personal_information" / "personal_information.json"
    )
    return decode(data["profile_user"][0]["string_map_data"]["Name"]["value"])


def read_threads(export: Path) -> Iterator[tuple[set[str], list[dict]]]:
    for folder in ("inbox", "message_requests"):
        base = export / "messages" / folder
        if not base.is_dir():
            continue
        for directory in sorted(base.iterdir()):
            participants: set[str] = set()
            messages: list[dict] = []
            for file in sorted(directory.glob("message_*.json")):
                data = read_json(file)
                participants.update(
                    decode(p["name"]) for p in data["participants"]
                )
                messages.extend(data["messages"])
            if messages:
                yield participants, messages


def load(export: Path) -> list[Chat]:
    me = self_name(export)
    chats = []
    for participants, raw_messages in read_threads(export):
        others = participants - {me}
        if len(others) != 1:
            continue
        (person,) = others
        messages = sorted(
            (parse_message(m, me) for m in raw_messages),
            key=lambda m: m.timestamp,
        )
        chats.append(Chat(person, messages))
    return chats


Measure = Callable[[Message], int]


def text_of(m: Message) -> str:
    return m.body.text if isinstance(m.body, Text) else ""


def count(_: Message) -> int:
    return 1


def characters(m: Message) -> int:
    return len(text_of(m))


def words(m: Message) -> int:
    return len(text_of(m).split())


def media(m: Message) -> int:
    if isinstance(m.body, Media):
        return len(m.body.items)
    return 1 if isinstance(m.body, Audio) else 0


MEASURES: dict[str, Measure] = {
    "messages": count,
    "characters": characters,
    "words": words,
    "media": media,
}


K = TypeVar("K")


def tally(
    messages: Iterable[Message],
    key: Callable[[Message], K],
    measure: Measure,
) -> dict[K, int]:
    totals: dict[K, int] = defaultdict(int)
    for m in messages:
        totals[key(m)] += measure(m)
    return dict(totals)


def when(tz: tzinfo, of: Callable[[datetime], K]) -> Callable[[Message], K]:
    return lambda m: of(m.timestamp.astimezone(tz))


def hour(tz: tzinfo) -> Callable[[Message], int]:
    return when(tz, lambda t: t.hour)


def day(tz: tzinfo) -> Callable[[Message], date]:
    return when(tz, lambda t: t.date())


def weekday(tz: tzinfo) -> Callable[[Message], int]:
    return when(tz, lambda t: t.weekday())


def author(m: Message) -> Author:
    return m.author


def kind(m: Message) -> str:
    return type(m.body).__name__


def all_reactions(messages: Iterable[Message]) -> Iterator[Reaction]:
    return (r for m in messages for r in m.reactions)


def reaction_emojis(messages: Iterable[Message]) -> dict[str, int]:
    return dict(Counter(r.emoji for r in all_reactions(messages)))


def cumulative(daily: Mapping[date, int]) -> dict[date, int]:
    days = sorted(daily)
    return dict(zip(days, accumulate(daily[d] for d in days)))


@dataclass(frozen=True)
class Follow:
    username: str
    at: datetime


def parse_follows(entries: Iterable[dict]) -> list[Follow]:
    return [
        Follow(
            item["value"], 
            datetime.fromtimestamp(item["timestamp"], tz=timezone.utc)
        )
        for entry in entries
        for item in entry["string_list_data"]
    ]


def followers(export: Path) -> list[Follow]:
    base = export / "followers_and_following"
    return parse_follows(
        entry
        for file in sorted(base.glob("followers_*.json"))
        for entry in json.loads(file.read_text())
    )


def following(export: Path) -> list[Follow]:
    data = read_json(export / "followers_and_following" / "following.json")
    return parse_follows(data["relationships_following"])


def follows_by_day(follows: Iterable[Follow], tz: tzinfo) -> dict[date, int]:
    return dict(Counter(f.at.astimezone(tz).date() for f in follows))


def profile_url(follow: Follow) -> str:
    return f"https://www.instagram.com/{follow.username}"


@dataclass(frozen=True)
class Reciprocity:
    mutual: Sequence[Follow]
    you_follow_only: Sequence[Follow]
    follows_you_only: Sequence[Follow]


def reciprocity(
    followers: Sequence[Follow], following: Sequence[Follow]
) -> Reciprocity:
    follower_names = {f.username for f in followers}
    following_names = {f.username for f in following}
    return Reciprocity(
        mutual=[
            f for f in following if f.username in follower_names
        ],
        you_follow_only=[
            f for f in following if f.username not in follower_names
        ],
        follows_you_only=[
            f for f in followers if f.username not in following_names
        ],
    )


def labels(chats: Sequence[Chat]) -> list[str]:
    by_name = Counter(c.person for c in chats)
    used: Counter[str] = Counter()
    result: list[str] = []
    for chat in chats:
        base = (
            chat.person 
            if by_name[chat.person] == 1 
            else f"{chat.person} ({len(chat.messages)})"
        )
        used[base] += 1
        result.append(base if used[base] == 1 else f"{base} #{used[base]}")
    return result
