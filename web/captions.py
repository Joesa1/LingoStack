"""Retrieve existing YouTube captions, never transcribe or access browser cookies."""
import json
import sys
import yt_dlp
import requests
from youtube_transcript_api import YouTubeTranscriptApi

video_id = sys.argv[1]
try:
    class TimedSession(requests.Session):
        def request(self, *args, **kwargs):
            kwargs.setdefault('timeout', 15)
            return super().request(*args, **kwargs)
    session = TimedSession()
    api = YouTubeTranscriptApi(http_client=session)
    tracks = list(api.list(video_id))
    tracks.sort(key=lambda t: (not t.language_code.startswith('en'), t.is_generated))
    if not tracks:
        raise RuntimeError('NO_CAPTIONS')
    track = tracks[0]
    rows = track.fetch().to_raw_data()
    # Metadata failure must not discard successfully fetched captions.
    title = 'YouTube · ' + video_id
    try:
        meta = session.get('https://www.youtube.com/oembed', params={'url': 'https://www.youtube.com/watch?v=' + video_id, 'format': 'json'})
        if meta.ok: title = meta.json().get('title', title)
    except Exception: pass
    print(json.dumps({'title': title, 'language': track.language_code, 'rows': rows}, ensure_ascii=False))
except Exception:
    class Quiet:
        def debug(self, *_): pass
        def warning(self, *_): pass
        def error(self, *_): pass
    try:
        with yt_dlp.YoutubeDL({'quiet': True, 'logger': Quiet(), 'skip_download': True,
                              'socket_timeout': 15, 'retries': 1, 'extractor_retries': 1,
                              'noplaylist': True, 'extractor_args': {'youtube': {'skip': ['translated_subs']}}}) as ydl:
            info = ydl.extract_info('https://www.youtube.com/watch?v=' + video_id, download=False)
            choices = []
            for automatic, source in enumerate([info.get('subtitles', {}), info.get('automatic_captions', {})]):
                for language, formats in source.items():
                    for item in formats:
                        if item.get('ext') == 'json3' and language != 'live_chat':
                            choices.append((not language.startswith('en'), automatic, language, item['url']))
            if not choices:
                print(json.dumps({'error': 'NO_CAPTIONS'})); sys.exit(0)
            _, _, language, url = sorted(choices)[0]
            with ydl.urlopen(url) as response:
                data = json.loads(response.read(10_000_001))
            rows = [{'text': ''.join(seg.get('utf8', '') for seg in event.get('segs', [])),
                     'start': event.get('tStartMs', 0) / 1000,
                     'duration': event.get('dDurationMs', 0) / 1000} for event in data.get('events', [])]
            print(json.dumps({'title': info.get('title', video_id), 'language': language, 'rows': rows}, ensure_ascii=False))
    except Exception as error:
        message = str(error).lower()
        reason = 'NO_CAPTIONS' if 'subtitlesdisabled' in message else 'UNAVAILABLE' if any(x in message for x in ['private video', 'video unavailable', 'removed']) else 'NETWORK'
        print(json.dumps({'error': reason}))
