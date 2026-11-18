import { useTranslation, Trans } from "react-i18next";

export function App({ status }: { status: string }) {
  const { t, i18n } = useTranslation();

  // i18n-keys: "Active", "Inactive"
  const label = t(status);

  // i18n-keys: "Not Found", "Access Denied"
  const errorText = t(`errors.${status}`);

  return (
    <div>
      <h1>{t("Customer Information")}</h1>
      <button>{t("Save Changes")}</button>
      <p>{t("Customer Name")}</p>
      <Trans i18nKey="Welcome Back" />
      <span>{i18n.t("Logout")}</span>
      <span>{t(`errors.${status}`)}</span>
      <span>{errorText}</span>
      {label}
    </div>
  );
}
