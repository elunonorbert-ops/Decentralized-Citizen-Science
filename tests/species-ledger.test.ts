// species-ledger.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Observation {
  species: string;
  timestamp: number;
  location_lat: number;
  location_lon: number;
  location_desc: string;
  evidence_hash: Buffer;
  contributor: string;
  validator: string;
  metadata: string;
  confidence_score: number;
}

interface SpeciesAggregate {
  total_observations: number;
  last_observed: number;
  avg_confidence: number;
  population_trend: number;
}

interface RegionAggregate {
  species_count: number;
  total_observations: number;
  biodiversity_index: number;
}

interface Correction {
  note: string;
  corrector: string;
  timestamp: number;
}

interface ContractState {
  observations: Map<number, Observation>;
  observation_index_by_species: Map<string, { observation_id: number }>; // Key: `${species}|${timestamp}`
  observation_index_by_location: Map<string, { observation_ids: number[] }>; // Key: location_hash
  aggregates_by_species: Map<string, SpeciesAggregate>;
  aggregates_by_region: Map<string, RegionAggregate>;
  corrections: Map<number, Correction>;
  next_observation_id: number;
  total_observations: number;
  admin: string;
  paused: boolean;
  authorized_validator: string;
}

// Mock contract implementation
class SpeciesLedgerMock {
  private state: ContractState = {
    observations: new Map(),
    observation_index_by_species: new Map(),
    observation_index_by_location: new Map(),
    aggregates_by_species: new Map(),
    aggregates_by_region: new Map(),
    corrections: new Map(),
    next_observation_id: 1,
    total_observations: 0,
    admin: "deployer",
    paused: false,
    authorized_validator: "validator",
  };

  private ERR_UNAUTHORIZED = 100;
  private ERR_INVALID_OBSERVATION = 101;
  private ERR_ALREADY_EXISTS = 102;
  private ERR_INVALID_QUERY_PARAMS = 103;
  private ERR_NOT_FOUND = 104;
  private ERR_PAUSED = 105; // Added for pause

  private MAX_SPECIES_NAME_LEN = 50;
  private MAX_LOCATION_DESC_LEN = 100;
  private MAX_EVIDENCE_LEN = 1024;

  private mockHash(input: string): Buffer {
    // Simple mock hash
    return Buffer.from(input);
  }

  addObservation(
    caller: string,
    species: string,
    timestamp: number,
    lat: number,
    lon: number,
    location_desc: string,
    evidence_hash: Buffer,
    metadata: string,
    confidence_score: number,
    contributor: string
  ): ClarityResponse<number> {
    if (caller !== this.state.authorized_validator) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (
      species.length > this.MAX_SPECIES_NAME_LEN ||
      location_desc.length > this.MAX_LOCATION_DESC_LEN ||
      metadata.length > this.MAX_EVIDENCE_LEN ||
      confidence_score > 100
    ) {
      return { ok: false, value: this.ERR_INVALID_OBSERVATION };
    }
    const speciesKey = `${species}|${timestamp}`;
    if (this.state.observation_index_by_species.has(speciesKey)) {
      return { ok: false, value: this.ERR_ALREADY_EXISTS };
    }

    const obs_id = this.state.next_observation_id;
    const loc_hash = this.mockHash(`${lat}|${lon}`).toString("hex");
    const region_hash = this.mockHash(location_desc).toString("hex");

    // Store observation
    this.state.observations.set(obs_id, {
      species,
      timestamp,
      location_lat: lat,
      location_lon: lon,
      location_desc,
      evidence_hash,
      contributor,
      validator: caller,
      metadata,
      confidence_score,
    });

    // Index by species
    this.state.observation_index_by_species.set(speciesKey, { observation_id: obs_id });

    // Index by location
    const current_ids = this.state.observation_index_by_location.get(loc_hash)?.observation_ids ?? [];
    current_ids.push(obs_id);
    this.state.observation_index_by_location.set(loc_hash, { observation_ids: current_ids });

    // Update aggregates (simplified)
    const current_species_agg = this.state.aggregates_by_species.get(species) ?? {
      total_observations: 0,
      last_observed: 0,
      avg_confidence: 0,
      population_trend: 0,
    };
    const new_total = current_species_agg.total_observations + 1;
    const new_avg = Math.floor(
      (current_species_agg.avg_confidence * (new_total - 1) + confidence_score) / new_total
    );
    const new_trend = timestamp > current_species_agg.last_observed ? 1 : -1;
    this.state.aggregates_by_species.set(species, {
      total_observations: new_total,
      last_observed: timestamp,
      avg_confidence: new_avg,
      population_trend: new_trend,
    });

    const current_region_agg = this.state.aggregates_by_region.get(region_hash) ?? {
      species_count: 0,
      total_observations: 0,
      biodiversity_index: 0,
    };
    this.state.aggregates_by_region.set(region_hash, {
      species_count: current_region_agg.species_count, // Assume no new species check
      total_observations: current_region_agg.total_observations + 1,
      biodiversity_index: current_region_agg.biodiversity_index + 1,
    });

    this.state.next_observation_id += 1;
    this.state.total_observations += 1;

    return { ok: true, value: obs_id };
  }

  getObservation(obs_id: number): ClarityResponse<Observation | null> {
    return { ok: true, value: this.state.observations.get(obs_id) ?? null };
  }

  getSpeciesAggregate(species: string): ClarityResponse<SpeciesAggregate | null> {
    return { ok: true, value: this.state.aggregates_by_species.get(species) ?? null };
  }

  getRegionAggregate(region_hash: string): ClarityResponse<RegionAggregate | null> {
    return { ok: true, value: this.state.aggregates_by_region.get(region_hash) ?? null };
  }

  getTotalObservations(): ClarityResponse<number> {
    return { ok: true, value: this.state.total_observations };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  addCorrection(caller: string, obs_id: number, note: string): ClarityResponse<boolean> {
    const obs = this.state.observations.get(obs_id);
    if (!obs) {
      return { ok: false, value: this.ERR_NOT_FOUND };
    }
    if (caller !== obs.validator && caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.corrections.set(obs_id, { note, corrector: caller, timestamp: Date.now() });
    return { ok: true, value: true };
  }

  getCorrection(obs_id: number): ClarityResponse<Correction | null> {
    return { ok: true, value: this.state.corrections.get(obs_id) ?? null };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  validator: "validator",
  contributor: "contributor",
  user: "user",
};

describe("SpeciesLedger Contract", () => {
  let contract: SpeciesLedgerMock;

  beforeEach(() => {
    contract = new SpeciesLedgerMock();
    vi.resetAllMocks();
  });

  it("should allow authorized validator to add observation", () => {
    const evidence_hash = Buffer.from("test-hash");
    const addResult = contract.addObservation(
      accounts.validator,
      "Bald Eagle",
      1627849200,
      40712345, // 40.712345
      -74012345, // -74.012345
      "Central Park, NY",
      evidence_hash,
      "Healthy adult observed",
      95,
      accounts.contributor
    );
    expect(addResult).toEqual({ ok: true, value: 1 });

    const obs = contract.getObservation(1);
    expect(obs).toEqual({
      ok: true,
      value: expect.objectContaining({
        species: "Bald Eagle",
        confidence_score: 95,
      }),
    });
  });

  it("should prevent unauthorized caller from adding observation", () => {
    const evidence_hash = Buffer.from("test-hash");
    const addResult = contract.addObservation(
      accounts.user,
      "Bald Eagle",
      1627849200,
      40712345,
      -74012345,
      "Central Park, NY",
      evidence_hash,
      "Healthy adult observed",
      95,
      accounts.contributor
    );
    expect(addResult).toEqual({ ok: false, value: 100 });
  });

  it("should update aggregates after adding observation", () => {
    const evidence_hash = Buffer.from("test-hash");
    contract.addObservation(
      accounts.validator,
      "Bald Eagle",
      1627849200,
      40712345,
      -74012345,
      "Central Park, NY",
      evidence_hash,
      "Healthy adult observed",
      95,
      accounts.contributor
    );

    const agg = contract.getSpeciesAggregate("Bald Eagle");
    expect(agg).toEqual({
      ok: true,
      value: {
        total_observations: 1,
        last_observed: 1627849200,
        avg_confidence: 95,
        population_trend: 1,
      },
    });
  });

  it("should prevent adding duplicate observation by species and timestamp", () => {
    const evidence_hash = Buffer.from("test-hash");
    contract.addObservation(
      accounts.validator,
      "Bald Eagle",
      1627849200,
      40712345,
      -74012345,
      "Central Park, NY",
      evidence_hash,
      "Healthy adult observed",
      95,
      accounts.contributor
    );

    const duplicateResult = contract.addObservation(
      accounts.validator,
      "Bald Eagle",
      1627849200,
      40712345,
      -74012345,
      "Central Park, NY",
      evidence_hash,
      "Duplicate",
      90,
      accounts.contributor
    );
    expect(duplicateResult).toEqual({ ok: false, value: 102 });
  });

  it("should allow validator or admin to add correction", () => {
    const evidence_hash = Buffer.from("test-hash");
    contract.addObservation(
      accounts.validator,
      "Bald Eagle",
      1627849200,
      40712345,
      -74012345,
      "Central Park, NY",
      evidence_hash,
      "Healthy adult observed",
      95,
      accounts.contributor
    );

    const correctionResult = contract.addCorrection(accounts.validator, 1, "Location adjusted");
    expect(correctionResult).toEqual({ ok: true, value: true });

    const correction = contract.getCorrection(1);
    expect(correction).toEqual({
      ok: true,
      value: expect.objectContaining({ note: "Location adjusted" }),
    });
  });

  it("should prevent non-authorized from adding correction", () => {
    const evidence_hash = Buffer.from("test-hash");
    contract.addObservation(
      accounts.validator,
      "Bald Eagle",
      1627849200,
      40712345,
      -74012345,
      "Central Park, NY",
      evidence_hash,
      "Healthy adult observed",
      95,
      accounts.contributor
    );

    const correctionResult = contract.addCorrection(accounts.user, 1, "Unauthorized");
    expect(correctionResult).toEqual({ ok: false, value: 100 });
  });

  it("should pause and unpause contract", () => {
    const pauseResult = contract.pauseContract(accounts.deployer);
    expect(pauseResult).toEqual({ ok: true, value: true });

    const evidence_hash = Buffer.from("test-hash");
    const addDuringPause = contract.addObservation(
      accounts.validator,
      "Bald Eagle",
      1627849200,
      40712345,
      -74012345,
      "Central Park, NY",
      evidence_hash,
      "Paused add",
      95,
      accounts.contributor
    );
    expect(addDuringPause).toEqual({ ok: false, value: 105 });

    const unpauseResult = contract.unpauseContract(accounts.deployer);
    expect(unpauseResult).toEqual({ ok: true, value: true });
  });

  it("should handle invalid observation parameters", () => {
    const evidence_hash = Buffer.from("test-hash");
    const invalidSpecies = "a".repeat(51); // Too long
    const addResult = contract.addObservation(
      accounts.validator,
      invalidSpecies,
      1627849200,
      40712345,
      -74012345,
      "Central Park, NY",
      evidence_hash,
      "Invalid",
      95,
      accounts.contributor
    );
    expect(addResult).toEqual({ ok: false, value: 101 });
  });
});