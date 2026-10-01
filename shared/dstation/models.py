"""Pydantic-схемы входного потока телеметрии: валидация на входе ingest."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

TrainStatus = Literal["scheduled", "approaching", "held", "at_signal", "entering", "on_track",
                      "departing", "departed", "rerouted"]


class TrainState(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str = Field(min_length=1, max_length=16)
    cat: Literal["pass", "freight_transit", "freight_local"]
    length_m: int = Field(gt=0, le=2000)
    side_in: Literal["W", "E"]
    side_out: Literal["W", "E"]
    status: TrainStatus
    track: Optional[str] = None
    pos_m: float = Field(ge=-500, le=50000)
    speed_kmh: float = Field(ge=0, le=200)
    planned_arr: int
    planned_dep: int
    eta: int
    service_s: int = Field(ge=0)

    @field_validator("pos_m")
    @classmethod
    def clamp_pos(cls, v: float) -> float:
        return max(0.0, v)


class TrackState(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    status: Literal["free", "occupied", "closed", "reserve"]
    train: Optional[str] = None


class WorldState(BaseModel):
    model_config = ConfigDict(extra="allow")
    world: Literal["ai", "baseline"]
    sim_time: int = Field(ge=0)
    trains: list[TrainState]
    upcoming: list[dict[str, Any]] = []
    tracks: list[TrackState]
    ladders: list[dict[str, Any]] = []
    locos: list[dict[str, Any]]
    crews: list[dict[str, Any]]
    kpi: dict[str, Any]


class TelemetryMsg(BaseModel):
    type: Literal["telemetry"]
    world: Literal["ai", "baseline"]
    seq: int = Field(ge=0)
    emitted_at: int                 # unix ms
    time_scale: float = Field(gt=0, le=1000)
    state: WorldState


class EventMsg(BaseModel):
    type: Literal["event"]
    seq: int = Field(ge=0)
    emitted_at: int
    event: dict[str, Any]
