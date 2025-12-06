import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    MISSKEY_INSTANCE = os.getenv("MISSKEY_INSTANCE")
    MISSKEY_TOKEN = os.getenv("MISSKEY_TOKEN")
    OLLAMA_URL = os.getenv("OLLAMA_URL")
    OLLAMA_MODEL = os.getenv("OLLAMA_MODEL")
    CHECK_INTERVAL_SECONDS = int(os.getenv("CHECK_INTERVAL_SECONDS", 300))

config = Config()