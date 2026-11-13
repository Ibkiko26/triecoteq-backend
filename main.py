import asyncio
from typing import List, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
import yt_dlp
from pydantic import BaseModel

app = FastAPI(title="IBKIKOVIDZ API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class FormatInfo(BaseModel):
    format_id: str
    ext: str
    resolution: Optional[str]
    fps: Optional[float]
    filesize: Optional[int]
    audio_only: bool
    vcodec: Optional[str]
    acodec: Optional[str]


class VideoMeta(BaseModel):
    title: str
    thumbnail: str
    duration: int
    platform: str
    formats: List[FormatInfo]


@app.get("/extract")
async def extract(url: str = Query(..., description="Valid URL to a video or media page.")):
    if not _is_valid_url(url):
        raise HTTPException(status_code=400, detail="A valid http/https URL is required.")

    try:
        loop = asyncio.get_running_loop()
        info = await loop.run_in_executor(None, _extract_info, url)
        return info
    except yt_dlp.utils.YoutubeDLError as exc:
        raise HTTPException(status_code=400, detail=f"Unable to extract video metadata: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected extraction error: {exc}") from exc


def _is_valid_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _extract_info(url: str):
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "noplaylist": True,
        "skip_download": True,
        "extractor_args": {"youtube": {"player_client": ["web", "android"]}},
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if not isinstance(info, dict):
        raise ValueError("No metadata returned for the supplied URL.")

    formats = []
    for item in info.get("formats", []):
        if not isinstance(item, dict):
            continue

        audio_only = item.get("vcodec") == "none" and item.get("acodec") != "none"
        resolution = item.get("resolution") or item.get("format_note") or item.get("height")
        if resolution is not None:
            resolution = str(resolution)

        formats.append(
            FormatInfo(
                format_id=str(item.get("format_id", "unknown")),
                ext=str(item.get("ext", "unknown")),
                resolution=resolution,
                fps=item.get("fps"),
                filesize=item.get("filesize"),
                audio_only=audio_only,
                vcodec=item.get("vcodec"),
                acodec=item.get("acodec"),
            )
        )

    return VideoMeta(
        title=str(info.get("title") or "Unknown"),
        thumbnail=str(info.get("thumbnail") or ""),
        duration=int(info.get("duration") or 0),
        platform=str(info.get("extractor_key") or info.get("extractor") or "unknown"),
        formats=formats,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)