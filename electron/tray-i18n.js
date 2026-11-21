'use strict';
// Strings for the native tray menu (the HTML UI has its own dictionary in renderer/i18n.js).

const STRINGS = {
  fa: {
    // macOS: the Keychain did not give the key of the saved servers (see main.js, loadEncryptedState)
    kcTitle: 'Best به Keychain مک دسترسی ندارد', kcDetail: 'سرورها و اشتراک‌ها با Keychain مک رمزگذاری شده‌اند. «دوباره» Best را از نو باز می‌کند؛ در پنجره‌ی مک «Always Allow» را انتخاب کنید. اگر Keychain عوض شده، «شروع از صفر» داده‌های قبلی را دست‌نخورده کنار می‌گذارد.', kcRetry: 'دوباره', kcEmpty: 'شروع از صفر',
    // macOS: the text in the system password prompt for installing / removing the TUN helper
    tunHelperPrompt: 'Best می‌خواهد سرویس کمکی TUN را نصب کند (حالت TUN یعنی همه‌ی ترافیک سیستم از تونل).', tunHelperRemovePrompt: 'Best می‌خواهد سرویس کمکی TUN را حذف کند.',
    connected: 'متصل', disconnected: 'قطع', proxyOn: 'روشن کردن پروکسی سیستم', proxyOff: 'خاموش کردن پروکسی سیستم', connect: 'اتصال', disconnect: 'قطع اتصال',
    systemProxy: 'پروکسی سیستم', off: 'خاموش', on: 'روشن', keep: 'دست نزن',
    routing: 'مسیریابی', global: 'همه از پروکسی', bypassLocal: 'کشور من مستقیم', direct: 'همه مستقیم',
    servers: 'سرورها', updateSubs: 'به‌روزرسانی اشتراک‌ها', open: 'باز کردن Best', quit: 'خروج',
  },
  en: {
    kcTitle: 'Best cannot reach the macOS Keychain', kcDetail: 'Servers and subscriptions are encrypted with the macOS Keychain. Try again restarts Best; choose “Always Allow” in the macOS prompt. If the Keychain was reset, Start empty sets the old data aside untouched.', kcRetry: 'Try again', kcEmpty: 'Start empty',
    tunHelperPrompt: 'Best wants to install its TUN helper service (TUN mode sends all system traffic through the tunnel).', tunHelperRemovePrompt: 'Best wants to remove its TUN helper service.',
    connected: 'Connected', disconnected: 'Disconnected', proxyOn: 'Turn system proxy on', proxyOff: 'Turn system proxy off', connect: 'Connect', disconnect: 'Disconnect',
    systemProxy: 'System proxy', off: 'Off', on: 'On', keep: 'Unchanged',
    routing: 'Routing', global: 'Global', bypassLocal: 'My country direct', direct: 'Direct',
    servers: 'Servers', updateSubs: 'Update subscriptions', open: 'Open Best', quit: 'Quit',
  },
  ru: {
    kcTitle: 'Best не может получить доступ к связке ключей macOS', kcDetail: 'Серверы и подписки зашифрованы с помощью связки ключей macOS. «Повторить» перезапустит Best; выберите «Разрешать всегда» в окне macOS. Если связка ключей была сброшена, «Начать с нуля» отложит старые данные нетронутыми.', kcRetry: 'Повторить', kcEmpty: 'Начать с нуля',
    tunHelperPrompt: 'Best хочет установить вспомогательную службу TUN (в режиме TUN весь трафик системы идёт через туннель).', tunHelperRemovePrompt: 'Best хочет удалить вспомогательную службу TUN.',
    connected: 'Подключено', disconnected: 'Отключено', proxyOn: 'Включить системный прокси', proxyOff: 'Выключить системный прокси', connect: 'Подключиться', disconnect: 'Отключиться',
    systemProxy: 'Системный прокси', off: 'Выкл.', on: 'Вкл.', keep: 'Не менять',
    routing: 'Маршрутизация', global: 'Всё через прокси', bypassLocal: 'Моя страна напрямую', direct: 'Всё напрямую',
    servers: 'Серверы', updateSubs: 'Обновить подписки', open: 'Открыть Best', quit: 'Выход',
  },
  zh: {
    kcTitle: 'Best 无法访问 macOS 钥匙串', kcDetail: '服务器和订阅使用 macOS 钥匙串加密。“重试”会重新启动 Best；请在 macOS 提示中选择“始终允许”。如果钥匙串已被重置，“重新开始”会把旧数据原样保留在一旁。', kcRetry: '重试', kcEmpty: '重新开始',
    tunHelperPrompt: 'Best 想要安装其 TUN 辅助服务（TUN 模式会让所有系统流量通过隧道）。', tunHelperRemovePrompt: 'Best 想要移除其 TUN 辅助服务。',
    connected: '已连接', disconnected: '未连接', proxyOn: '开启系统代理', proxyOff: '关闭系统代理', connect: '连接', disconnect: '断开连接',
    systemProxy: '系统代理', off: '关闭', on: '开启', keep: '不更改',
    routing: '路由', global: '全局', bypassLocal: '本国直连', direct: '直连',
    servers: '服务器', updateSubs: '更新订阅', open: '打开 Best', quit: '退出',
  },
};

module.exports = (lang) => STRINGS[lang] || STRINGS.en;
