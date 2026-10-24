export const FAQ = Object.freeze({
  start: {
    title: "Бот не отвечает или не открывается",
    text: "Откройте @RE_Program_Bot и отправьте /start. Если ошибка осталась, напишите нам: какой раздел открывали, что произошло и примерно когда. Можно приложить скриншот без личных данных.",
  },
  partner: {
    title: "Партнёрский профиль и модерация",
    text: "Партнёрские функции требуют подтверждения 18+ и ручного одобрения. Partner Beta открывается отдельно. Если получили отказ, проверьте указанную причину; если она непонятна, попросите разъяснение или повторную проверку через поддержку.",
  },
  stats: {
    title: "Ссылка и статистика",
    text: "Переход, регистрация и подтверждённый результат — разные события. Первая действующая привязка сохраняется при смене username. Если заметили расхождение, укажите внутренний номер ссылки или заявки и период.",
  },
  privacy: {
    title: "Данные и удаление аккаунта",
    text: "Данными основного бота можно управлять через раздел приватности в @RE_Program_Bot. Этот бот поддержки не удаляет аккаунт в RE Program. Для вопроса о данных или удаления переписки поддержки создайте обращение с темой «Мои данные».",
  },
});
export const WARNING = "Не отправляйте пароли, коды входа, токены, паспорт и банковские реквизиты. Перед отправкой скриншота скройте личные данные.";

const RULES = Object.freeze({
  start: [
    [/(?:^|\s)(?:бот|bot|start|старт)(?:\s|$)/iu, 1],
    [/(?:не\s*(?:работает|отвечает|открывается|запускается)|не\s*могу\s*(?:открыть|запустить|зайти)|завис|ошибк|недоступ)/iu, 3],
    [/(?:doesn'?t\s*(?:work|answer|open|start)|not\s*(?:working|opening)|error|stuck)/iu, 3],
  ],
  partner: [
    [/(?:партн[её]р|partner)/iu, 4],
    [/(?:модерац|заявк|одобр|отказ|самозан|верификац|18\s*\+?)/iu, 3],
    [/(?:moderation|application|approved|rejected|self.?employ)/iu, 3],
  ],
  stats: [
    [/(?:ссылк|реферал|приглаш|link|referral|invite)/iu, 4],
    [/(?:статист|переход|клик|засчит|привяз|регистрац|stats?|click|counted|tracking)/iu, 3],
  ],
  privacy: [
    [/(?:удал(?:ить|ение)?\s*(?:мой\s*)?(?:аккаунт|профил)|мо[и-я]*\s+данн|персональн\w*\s+данн)/iu, 5],
    [/(?:приватност|конфиденциальн|паспорт|реквизит|privacy|personal\s+data|delete\s+(?:my\s+)?account)/iu, 4],
    [/(?:удал|данн|аккаунт|профил|delete|data|account)/iu, 1],
  ],
});

const normalize = value => String(value ?? "")
  .normalize("NFKC")
  .toLocaleLowerCase("ru-RU")
  .replace(/ё/g, "е")
  .replace(/[^a-zа-я0-9+\s_-]+/giu, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 2000);

export function matchFAQ(value) {
  const text = normalize(value);
  if (!text) return null;
  const ranked = Object.entries(RULES).map(([key, rules]) => ({
    key,
    score: rules.reduce((total, [pattern, weight]) => total + (pattern.test(text) ? weight : 0), 0),
  })).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  if (ranked[0].score < 4 || (ranked[1] && ranked[0].score === ranked[1].score)) return null;
  return ranked[0].key;
}
