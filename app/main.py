from fastapi import FastAPI

app = FastAPI()


@app.get("/heatlth")
async def health_check():
    return {"status": "ok"}
