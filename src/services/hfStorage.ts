const HF_REPO_KEY = 'clover_hf_repo';
const HF_TOKEN_KEY = 'clover_hf_token';
const DATA_SOURCE_KEY = 'clover_data_source'; // 'hf' | 'local'
const ENGINE_URL_KEY = 'clover_engine_url';
const GH_REPO_KEY = 'clover_gh_repo';
const GH_TOKEN_KEY = 'clover_gh_token';

export interface HFConfig {
  hfRepo: string;
  hfToken: string;
  source: 'hf' | 'local';
  engineUrl: string;
  ghRepo: string;
  ghToken: string;
}

export const DEFAULT_HF_REPO = 'learner20011/CloverTexts-Data';
export const DEFAULT_GH_REPO = 'rahathasan452/clover';

export function getHFConfig(): HFConfig {
  const hfRepo = localStorage.getItem(HF_REPO_KEY) || DEFAULT_HF_REPO;
  const hfToken = localStorage.getItem(HF_TOKEN_KEY) || '';
  const source =
    (localStorage.getItem(DATA_SOURCE_KEY) as 'hf' | 'local') || (hfRepo ? 'hf' : 'local');
  const engineUrl = (localStorage.getItem(ENGINE_URL_KEY) || '').replace(/\/+$/, '');
  const ghRepo = localStorage.getItem(GH_REPO_KEY) || DEFAULT_GH_REPO;
  const ghToken = localStorage.getItem(GH_TOKEN_KEY) || '';
  return { hfRepo, hfToken, source, engineUrl, ghRepo, ghToken };
}

export function saveHFConfig(config: Partial<HFConfig>): void {
  if (config.hfRepo !== undefined) localStorage.setItem(HF_REPO_KEY, config.hfRepo.trim());
  if (config.hfToken !== undefined) localStorage.setItem(HF_TOKEN_KEY, config.hfToken.trim());
  if (config.source !== undefined) localStorage.setItem(DATA_SOURCE_KEY, config.source);
  if (config.engineUrl !== undefined) {
    localStorage.setItem(ENGINE_URL_KEY, config.engineUrl.trim().replace(/\/+$/, ''));
  }
  if (config.ghRepo !== undefined) localStorage.setItem(GH_REPO_KEY, config.ghRepo.trim());
  if (config.ghToken !== undefined) localStorage.setItem(GH_TOKEN_KEY, config.ghToken.trim());
}

export function resolveLocalPath(relativePath: string): string {
  const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  const base: string = ((import.meta as any).env?.BASE_URL as string) || '/';
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}${cleanPath}`;
}

export function resolveAssetUrl(relativePath: string): string {
  const { hfRepo, source } = getHFConfig();
  const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;

  if (source === 'hf' && hfRepo) {
    return `https://huggingface.co/datasets/${hfRepo}/resolve/main/${cleanPath}`;
  }

  return resolveLocalPath(cleanPath);
}

export function getAuthHeaders(): Record<string, string> {
  const { hfToken, source } = getHFConfig();
  if (source === 'hf' && hfToken) {
    return { Authorization: `Bearer ${hfToken}` };
  }
  return {};
}
