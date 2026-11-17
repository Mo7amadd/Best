'use strict';
// Strings for the native tray menu (the HTML UI has its own dictionary in renderer/i18n.js).

const STRINGS = {
  fa: {
    connected: 'متصل', disconnected: 'قطع', proxyOn: 'روشن کردن پروکسی سیستم', proxyOff: 'خاموش کردن پروکسی سیستم', connect: 'اتصال', disconnect: 'قطع اتصال',
    systemProxy: 'پروکسی سیستم', off: 'خاموش', on: 'روشن', keep: 'دست نزن',
    routing: 'مسیریابی', global: 'همه از پروکسی', bypassLocal: 'کشور من مستقیم', direct: 'همه مستقیم',
    servers: 'سرورها', updateSubs: 'به‌روزرسانی اشتراک‌ها', open: 'باز کردن Best', quit: 'خروج',
  },
  en: {
    connected: 'Connected', disconnected: 'Disconnected', proxyOn: 'Turn system proxy on', proxyOff: 'Turn system proxy off', connect: 'Connect', disconnect: 'Disconnect',
    systemProxy: 'System proxy', off: 'Off', on: 'On', keep: 'Unchanged',
    routing: 'Routing', global: 'Global', bypassLocal: 'My country direct', direct: 'Direct',
    servers: 'Servers', updateSubs: 'Update subscriptions', open: 'Open Best', quit: 'Quit',
  },
  ru: {
    connected: 'Подключено', disconnected: 'Отключено', proxyOn: 'Включить системный прокси', proxyOff: 'Выключить системный прокси', connect: 'Подключиться', disconnect: 'Отключиться',
    systemProxy: 'Системный прокси', off: 'Выкл.', on: 'Вкл.', keep: 'Не менять',
    routing: 'Маршрутизация', global: 'Всё через прокси', bypassLocal: 'Моя страна напрямую', direct: 'Всё напрямую',
    servers: 'Серверы', updateSubs: 'Обновить подписки', open: 'Открыть Best', quit: 'Выход',
  },
};

module.exports = (lang) => STRINGS[lang] || STRINGS.en;
