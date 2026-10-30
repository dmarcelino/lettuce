/**
 * Base URL and API key, the two fields every endpoint form asks for: the provider
 * form (named providers and connections alike) and a connection's edit sheet.
 */
export function EndpointFields(props: {
  baseUrl: string;
  baseUrlPlaceholder?: string | undefined;
  /** Shown under the Base URL, e.g. what a custom endpoint costs on this host. */
  note?: string | null | undefined;
  onBaseUrl: (value: string) => void;
  apiKey: string;
  keyPlaceholder: string;
  onApiKey: (value: string) => void;
}) {
  return (
    <>
      <label className="field">
        Base URL
        <input
          value={props.baseUrl}
          placeholder={props.baseUrlPlaceholder}
          onChange={(event) => props.onBaseUrl(event.target.value)}
        />
        {props.note ? <span className="small">{props.note}</span> : null}
      </label>
      <label className="field">
        API key
        <input
          type="password"
          value={props.apiKey}
          autoComplete="off"
          placeholder={props.keyPlaceholder}
          onChange={(event) => props.onApiKey(event.target.value)}
        />
      </label>
    </>
  );
}
