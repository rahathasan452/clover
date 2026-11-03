const HF_REPO_KEY = 'clover_hf_repo';
const HF_TOKEN_KEY = 'clover_hf_token';
const DATA_SOURCE_KEY = 'clover_data_source'; // 'hf' | 'local'

export interface HFConfig {
  hfRepo: string;
  hfToken: string;
  source: 'hf' | 'local';
}

export const DEFAULT_HF_REPO = 'learner20011/CloverTexts-Data';

export function getHFConfig(): HFConfig {
  const hfRepo = localStorage.getItem(HF_REPO_KEY) || DEFAULT_HF_REPO;
  const hfToken = localStorage.getItem(HF_TOKEN_KEY) || '';
  const source =
    (localStorage.getItem(DATA_SOURCE_KEY) as 'hf' | 'local') || (hfRepo ? 'hf' : 'local');
  return { hfRepo, hfToken, source };
}

export function saveHFConfig(config: Partial<HFConfig>): void {
  if (config.hfRepo !== undefined) localStorage.setItem(HF_REPO_KEY, config.hfRepo.trim());
  if (config.hfToken !== undefined) localStorage.setItem(HF_TOKEN_KEY, config.hfToken.trim());
  if (config.source !== undefined) localStorage.setItem(DATA_SOURCE_KEY, config.source);
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
