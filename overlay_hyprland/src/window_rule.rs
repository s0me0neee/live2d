use crate::command;
use napi_derive::napi;

/// One dynamic windowrule property, e.g. `{ prop: "no_focus", value: "true" }`.
#[napi(object)]
pub struct WindowRule {
    pub prop: String,
    pub value: String,
}

/// Applies `windowrule[<name>]:<prop> <value>` keywords — the overlay treatment
/// (pin/float/no_focus/…) for windows matching `name`. Rules set this way are
/// session-scoped; pass `value: "unset"` to clear one. Fails on the first rule
/// the compositor rejects.
#[napi]
pub fn set_window_rules(name: String, rules: Vec<WindowRule>) -> napi::Result<()> {
    for rule in &rules {
        command::send_ok(&format!(
            "keyword windowrule[{name}]:{} {}",
            rule.prop, rule.value
        ))?;
        log!("windowrule[{name}]:{} {}", rule.prop, rule.value);
    }
    Ok(())
}
