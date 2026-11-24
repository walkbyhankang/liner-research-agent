#!/usr/bin/env python3
"""성장노트 데모 영상 내레이션을 Google TTS로 만든다.

대본과 줄별 어조는 같은 폴더의 seongjang-note-tts-lines.json에 있다.
결과 음성은 저장소의 results/tts/ 아래에 쓴다(results/는 커밋하지 않는다).

명령
  samples  한 줄을 여러 음성으로 만들어 비교한다.
  lines    모든 줄(또는 --only로 고른 줄)을 한 음성으로 만든다.
  report   만든 음성의 길이를 줄별 최대 길이와 비교한다.

백엔드 (--backend)
  gemini  Gemini API의 gemini-3.8-flash-tts. 환경 변수 GEMINI_API_KEY가 필요하다.
          pip install "google-genai>=2.25.0"
  cloud   Cloud Text-to-Speech의 gemini-3.1-flash-tts-preview. gcloud 기본 인증이 필요하다.
          pip install "google-cloud-texttospeech>=2.29.0"
  chirp   Cloud Text-to-Speech의 Chirp 3: HD(ko-KR-Chirp3-HD-<음성>). 어조 지정은 없고 속도만 정한다.

예
  python docs/submission/tts/synthesize.py samples --line L01
  python docs/submission/tts/synthesize.py lines --voice ko-kr-storyteller-4
  python docs/submission/tts/synthesize.py lines --voice ko-kr-storyteller-4 --only L06,P02
  python docs/submission/tts/synthesize.py report --voice ko-kr-storyteller-4
  python docs/submission/tts/synthesize.py lines --dry-run      # 보낼 내용만 출력
"""
import argparse
import base64
import csv
import json
import re
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
LINES_FILE = HERE / "seongjang-note-tts-lines.json"
OUT = REPO / "results" / "tts"

# 대본의 쉼 태그는 Gemini API 표기(<short pause>)로 적었다. 백엔드마다 표기가 다르다.
TAGS = {
    "gemini": {"<short pause>": "<short pause>", "<long pause>": "<long pause>"},
    "cloud": {"<short pause>": "[short pause]", "<long pause>": "[long pause]"},
    "chirp": {"<short pause>": "[pause short]", "<long pause>": "[pause long]"},
}


def load():
    doc = json.loads(LINES_FILE.read_text(encoding="utf-8"))
    return doc["defaults"], doc["lines"]


def convert(text, backend):
    for src, dst in TAGS[backend].items():
        text = text.replace(src, dst)
    return text


def synth_gemini(text, style, voice, model):
    from google import genai

    # GEMINI_API_KEY. TTS 모델은 v1beta에만 있다(v1에서는 404).
    client = genai.Client(http_options={"api_version": "v1beta"})
    interaction = client.interactions.create(
        model=model,
        input=[{
            "type": "user_input",
            "content": [{
                "type": "text",
                "text": text,
                "annotations": [{"type": "speech_metadata", "style": style}],
            }],
        }],
        response_format={"type": "audio"},
        generation_config={"speech_config": [{"voice": voice}]},
    )
    return base64.b64decode(interaction.output_audio.data)


def synth_cloud(text, style, voice, model, language_code):
    from google.cloud import texttospeech

    client = texttospeech.TextToSpeechClient()
    response = client.synthesize_speech(
        input=texttospeech.SynthesisInput(
            prompt=f"Read the following Korean narration. Style: {style}.", text=text),
        voice=texttospeech.VoiceSelectionParams(
            language_code=language_code, name=voice, model_name=model),
        audio_config=texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.LINEAR16),
    )
    return response.audio_content


def synth_chirp(text, voice, language_code, rate):
    from google.cloud import texttospeech

    client = texttospeech.TextToSpeechClient()
    response = client.synthesize_speech(
        input=texttospeech.SynthesisInput(markup=text),
        voice=texttospeech.VoiceSelectionParams(
            language_code=language_code, name=f"{language_code}-Chirp3-HD-{voice}"),
        audio_config=texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.LINEAR16, speaking_rate=rate),
    )
    return response.audio_content


def synth(line, voice, args, defaults):
    text = convert(line["tts_text"], args.backend)
    if args.backend == "chirp" and args.comma_pause:
        # 한국어 Chirp 3: HD 음성은 쉼표에서 쉬지 않는다는 보고가 있어 쉼 태그로 바꾼다.
        text = text.replace(", ", ", [pause short] ")
    if args.dry_run:
        print(f"[{line['id']}] voice={voice} backend={args.backend}")
        if args.backend != "chirp":
            print(f"  style: {line['style']}")
        print(f"  text : {text}")
        return None
    if args.backend == "gemini":
        return synth_gemini(text, line["style"], voice, args.model or defaults["model"])
    if args.backend == "cloud":
        return synth_cloud(text, line["style"], voice,
                           args.model or defaults["cloud_model"], defaults["language_code"])
    return synth_chirp(text, voice, defaults["language_code"], args.rate)


def default_voice(args, defaults):
    # 한국어 전용 음성(ko-kr-...)은 Gemini API에만 있다. cloud·chirp는 기본 음성 이름(Kore 등)을 쓴다.
    if args.voice:
        return args.voice
    return defaults["voice"] if args.backend == "gemini" else defaults["cloud_voice"]


def out_folder(args, voice):
    # 어조를 바꿔 다시 만들 때 --tag로 폴더를 나눠 이전 결과를 덮어쓰지 않는다.
    return OUT / args.backend / (f"{voice}-{args.tag}" if args.tag else voice)


def tag_name(value):
    # 폴더 이름 한 칸에만 붙는다. 경로 구분자나 ..로 결과 폴더 밖을 가리키지 못하게 한다.
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", value):
        raise argparse.ArgumentTypeError("영문·숫자·_·-만 쓸 수 있습니다 (예: fast, fast-retry)")
    return value


def seconds(path):
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def write(path, audio):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part.wav")
    tmp.write_bytes(audio)
    tmp.replace(path)
    return seconds(path)


def cmd_samples(args, defaults, lines):
    line = next(l for l in lines if l["id"] == args.line)
    voices = args.voices.split(",") if args.voices else defaults["sample_voices"]
    if not args.voices and args.backend != "gemini":
        voices = [v for v in voices if not v.startswith("ko-kr-")]  # Gemini API 전용 음성
    for voice in voices:
        audio = synth(line, voice, args, defaults)
        if audio is None:
            continue
        path = OUT / args.backend / "samples" / f"{line['id']}-{voice}.wav"
        sec = write(path, audio)
        print(f"{path.relative_to(REPO)}  {sec:.1f}초 (최대 {line['max_seconds']}초)")


def cmd_lines(args, defaults, lines):
    voice = default_voice(args, defaults)
    only = set(args.only.split(",")) if args.only else None
    for line in lines:
        if only and line["id"] not in only:
            continue
        audio = synth(line, voice, args, defaults)
        if audio is None:
            continue
        path = out_folder(args, voice) / f"{line['id']}.wav"
        sec = write(path, audio)
        mark = "넘침" if sec > line["max_seconds"] else "맞음"
        print(f"{line['id']}  {sec:5.1f}초 / 최대 {line['max_seconds']:5.1f}초  {mark}")
    if not args.dry_run:
        cmd_report(args, defaults, lines)


def cmd_report(args, defaults, lines):
    voice = default_voice(args, defaults)
    folder = out_folder(args, voice)
    rows, over = [], []
    for line in lines:
        path = folder / f"{line['id']}.wav"
        if not path.exists():
            continue
        sec = round(seconds(path), 2)
        ok = sec <= line["max_seconds"]
        rows.append([line["id"], line["start"], sec, line["max_seconds"], "맞음" if ok else "넘침"])
        if not ok:
            over.append(line["id"])
    if not rows:
        print(f"{folder.relative_to(REPO)}에 음성이 없습니다.")
        return
    report = folder / "report.csv"
    with report.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["번호", "시작(초)", "길이(초)", "최대(초)", "판정"])
        w.writerows(rows)
    total = sum(r[2] for r in rows)
    print(f"{len(rows)}줄, 합계 {total:.1f}초. 넘친 줄: {', '.join(over) or '없음'}")
    print(f"표: {report.relative_to(REPO)}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["samples", "lines", "report"])
    p.add_argument("--backend", choices=["gemini", "cloud", "chirp"], default="gemini")
    p.add_argument("--model", help="모델 ID를 바꿀 때")
    p.add_argument("--voice", help="lines/report에 쓸 음성 (기본: gemini는 defaults.voice, cloud·chirp는 defaults.cloud_voice)")
    p.add_argument("--voices", help="samples에 쓸 음성 목록, 쉼표로 구분")
    p.add_argument("--line", default="L01", help="samples에 쓸 줄 번호 (기본: L01)")
    p.add_argument("--only", help="lines에서 만들 줄 번호, 쉼표로 구분")
    p.add_argument("--rate", type=float, default=1.0, help="chirp의 speaking_rate (0.25~2.0)")
    p.add_argument("--comma-pause", action="store_true", help="chirp에서 쉼표마다 [pause short]를 넣음")
    p.add_argument("--tag", type=tag_name, help="lines/report의 결과 폴더 이름 뒤에 붙일 꼬리표 (예: fast → <음성>-fast)")
    p.add_argument("--dry-run", action="store_true", help="API를 부르지 않고 보낼 내용만 출력")
    args = p.parse_args()
    defaults, lines = load()
    {"samples": cmd_samples, "lines": cmd_lines, "report": cmd_report}[args.command](args, defaults, lines)


if __name__ == "__main__":
    sys.exit(main())
