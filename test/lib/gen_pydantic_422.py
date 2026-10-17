"""Regenerates test/lib/pydantic-422.json: what pydantic v2 reports for each case in validation.test.ts.

Run: uv run --with pydantic --with email-validator python test/lib/gen_pydantic_422.py
"""

import json
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, ValidationError, field_validator


class Name(BaseModel):
    name: str


class Short1(BaseModel):
    name: str = Field(min_length=1)


class Short3(BaseModel):
    name: str = Field(min_length=3)


class Long1(BaseModel):
    name: str = Field(max_length=1)


class Long5(BaseModel):
    name: str = Field(max_length=5)


class Ge1(BaseModel):
    n: int = Field(ge=1)


class Gt0(BaseModel):
    n: int = Field(gt=0)


class Le10(BaseModel):
    n: int = Field(le=10)


class Lt10(BaseModel):
    n: int = Field(lt=10)


class Int(BaseModel):
    n: int


class Flt(BaseModel):
    x: float


class Bool(BaseModel):
    b: bool


class Lst(BaseModel):
    items: list[int]


class LstMin(BaseModel):
    items: list[int] = Field(min_length=1)


class LstMax(BaseModel):
    items: list[int] = Field(max_length=2)


class Lit3(BaseModel):
    kind: Literal["a", "b", "c"]


class Lit2(BaseModel):
    kind: Literal["a", "b"]


class LitNum(BaseModel):
    n: Literal[1, 2]


class Email(BaseModel):
    email: EmailStr


class Custom(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def check(cls, v: str) -> str:
        raise ValueError("bad thing")


class Inner(BaseModel):
    x: int


class Outer(BaseModel):
    inner: Inner


class Mult(BaseModel):
    n: int = Field(multiple_of=5)


class Pat(BaseModel):
    code: str = Field(pattern=r"^\d+$")


CASES = [
    ("missing", Name, {}),
    ("string_too_short_1", Short1, {"name": ""}),
    ("string_too_short_3", Short3, {"name": "ab"}),
    ("string_too_long_1", Long1, {"name": "ab"}),
    ("string_too_long_5", Long5, {"name": "abcdefg"}),
    ("ge", Ge1, {"n": 0}),
    ("gt", Gt0, {"n": 0}),
    ("le", Le10, {"n": 11}),
    ("lt", Lt10, {"n": 10}),
    ("int_from_float", Int, {"n": 1.5}),
    ("int_parsing", Int, {"n": "abc"}),
    ("int_type", Int, {"n": None}),
    ("float_parsing", Flt, {"x": "x"}),
    ("float_type", Flt, {"x": None}),
    ("bool_parsing", Bool, {"b": "maybe"}),
    ("bool_type", Bool, {"b": None}),
    ("string_type", Name, {"name": 5}),
    ("list_type", Lst, {"items": "x"}),
    ("list_item", Lst, {"items": ["a"]}),
    ("too_short", LstMin, {"items": []}),
    ("too_long", LstMax, {"items": [1, 2, 3]}),
    ("literal_3", Lit3, {"kind": "d"}),
    ("literal_2", Lit2, {"kind": "d"}),
    ("literal_num", LitNum, {"n": 3}),
    ("email_no_at", Email, {"email": "nope"}),
    ("email_no_local", Email, {"email": "@example.com"}),
    ("email_no_period", Email, {"email": "a@b"}),
    ("custom", Custom, {"name": "x"}),
    ("nested_missing", Outer, {"inner": {}}),
    ("model_type", Name, "x"),
    ("multiple_of", Mult, {"n": 7}),
    ("pattern", Pat, {"code": "a"}),
]

out = {}
for name, model, data in CASES:
    try:
        model.model_validate(data)
    except ValidationError as e:
        err = e.errors(include_url=False)[0]
        out[name] = {"type": err["type"], "loc": ["body", *err["loc"]], "msg": err["msg"]}

with open("test/lib/pydantic-422.json", "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(len(out))
