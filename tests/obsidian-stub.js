'use strict';
// Minimal stub of the 'obsidian' module so main.js can be loaded under Node
// for unit tests. Only the names main.js destructures need to exist.
class Plugin {}
class PluginSettingTab {}
class Setting {}
class Notice {}
class Modal {}
class Menu {}
class TFolder {}
class TFile {}
class AbstractInputSuggest {}
function normalizePath(p) { return p; }
function parseYaml() { throw new Error('parseYaml stub not implemented for tests'); }
module.exports = {
  Plugin, PluginSettingTab, Setting, Notice, Modal, Menu, TFolder, TFile,
  AbstractInputSuggest, normalizePath, parseYaml,
};
