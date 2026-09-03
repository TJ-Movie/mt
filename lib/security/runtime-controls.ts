export type RuntimeControls = Readonly<{
  externalLinksEnabled: boolean;
  adsEnabled: boolean;
}>;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

/** All risky features fail closed when an environment value is missing. */
export function getRuntimeControls(
  environment: RuntimeEnvironment = process.env,
): RuntimeControls {
  return {
    externalLinksEnabled: enabled(environment.SUBLYRA_EXTERNAL_LINKS_ENABLED),
    adsEnabled: enabled(environment.SUBLYRA_ADS_ENABLED),
  };
}
