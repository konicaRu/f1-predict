export type RaceStatus = 'demo' | 'open' | 'closed' | 'resulted';

export interface Race {
  id: number;
  season: number;
  round: number;
  name: string;
  race_datetime_utc: string | null;
  deadline_utc: string;
  status: RaceStatus;
  scored: boolean;
}

export interface Driver {
  id: string;
  code: string;
  name: string;
  team: string | null;
  team_color: string | null;
  standing: number | null;
}

export type SaveErrorCode = 'deadline' | 'shape' | 'pool' | 'admin' | 'unknown';

export class SaveError extends Error {
  code: SaveErrorCode;
  constructor(code: SaveErrorCode, message: string) {
    super(message);
    this.name = 'SaveError';
    this.code = code;
  }
}

export interface Score {
  user_id: string;
  race_id: number;
  points: number;
  exact_hits: number;
}

export interface LeagueUser {
  id: string;
  display_name: string;
}
