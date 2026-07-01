use napi::Error;
use napi::Status;
use napi::bindgen_prelude::Result;
mod kb_deamon;
use napi_derive::napi;
use std::{
    io::{Stdin, Stdout},
    process::Stdio,
};

#[test]
fn platform() {
    let os = std::env::consts::OS;
    assert_ne!(os, "windows")
}
