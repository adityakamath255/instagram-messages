import json
from collections import defaultdict
from collections.abc import Callable, Iterable, Iterator, Sequence
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
    data = read_json(export / "personal_information" / "personal_information.json")
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


def reactions(m: Message) -> int:
    return len(m.reactions)


MEASURES: dict[str, Measure] = {
    "messages": count,
    "characters": characters,
    "words": words,
    "media": media,
    "reactions": reactions,
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


def hour(tz: tzinfo) -> Callable[[Message], int]:
    return lambda m: m.timestamp.astimezone(tz).hour


def day(tz: tzinfo) -> Callable[[Message], date]:
    return lambda m: m.timestamp.astimezone(tz).date()


def author(m: Message) -> Author:
    return m.author


def cumulative(daily: dict[date, int]) -> dict[date, int]:
    days = sorted(daily)
    return dict(zip(days, accumulate(daily[d] for d in days)))
