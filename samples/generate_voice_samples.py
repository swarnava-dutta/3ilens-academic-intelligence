"""Generate two SYNTHETIC voice-answer samples (FR-2.8 demo) with OpenAI text-to-speech.

    backend\\.venv\\Scripts\\python.exe samples\\generate_voice_samples.py

- voice_answer_genetics_en.mp3       - an English answer to Genetics Q1 (test cross), about 25 s.
- voice_answer_genetics_hinglish.mp3 - a Hindi-English answer to Genetics Q3 (semi-conservative
                                       replication), Devanagari plus English scientific terms.

Both are computer-generated (TTS) speech written for the demo, not real students. The model is
gpt-4o-mini-tts (announced shutdown 2027-01-06 - fine for a one-off sample). Two short clips cost
a few US cents. The key is read from the project .env (OPENAI_API_KEY) and is never printed; with
no key the script prints "skipped: no OPENAI_API_KEY" and exits 0. Existing files are kept unless
--force is given.
"""
from __future__ import annotations

import sys
from pathlib import Path

SAMPLES = Path(__file__).resolve().parent
BACKEND = SAMPLES.parent / "backend"
sys.path.insert(0, str(BACKEND))

TTS_MODEL = "gpt-4o-mini-tts"
VOICE = "alloy"
CLIPS = (
    (
        "voice_answer_genetics_en.mp3",
        "Question one. The heterozygous tall plant is capital T small t, and the dwarf plant is small t small t. "
        "The tall plant gives gametes capital T and small t, and the dwarf plant gives only small t. "
        "So the offspring are T t and t t in a one to one ratio. Genotypic ratio one is to one, "
        "and phenotypic ratio one tall to one dwarf. This is called a test cross. "
        "It tells us whether a tall plant is homozygous or heterozygous.",
        "Speak like a calm Indian student answering a viva, at a steady pace.",
    ),
    (
        "voice_answer_genetics_hinglish.mp3",
        "Question three. DNA replication semi-conservative होता है - मतलब हर daughter DNA में "
        "एक parental strand पुराना होता है और एक नया strand बनता है। "
        "इसे Meselson और Stahl ने prove किया था। उन्होंने E. coli को पहले 15N medium में grow किया, "
        "फिर 14N में transfer किया, और CsCl density gradient centrifugation से DNA को अलग किया। "
        "एक generation के बाद सारा DNA hybrid था, 15N और 14N का।",
        "Speak like an Indian student mixing Hindi and English naturally, at a steady pace.",
    ),
)


def main(argv: list[str]) -> int:
    from config import get_settings

    settings = get_settings()
    if not settings.openai_api_key:
        print("skipped: no OPENAI_API_KEY")
        return 0
    import ai  # the project's OpenAI client (base URL pinned from .env)

    client = ai._openai_client(settings)
    force = "--force" in argv
    for name, text, instructions in CLIPS:
        target = SAMPLES / name
        if target.exists() and not force:
            print(f"kept {name} (exists; --force regenerates)")
            continue
        response = client.audio.speech.create(
            model=TTS_MODEL, voice=VOICE, input=text, instructions=instructions, response_format="mp3",
        )
        target.write_bytes(response.content)
        print(f"wrote {name} ({target.stat().st_size / 1024:.0f} KB, {len(text)} characters of synthetic TTS)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
