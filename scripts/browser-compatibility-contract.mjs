export const SAFARI_15_OBJECT_HAS_OWN_BANNER =
  'if(typeof Object.hasOwn!=="function"){Object.defineProperty(Object,"hasOwn",{configurable:true,value:function(object,property){return Object.prototype.hasOwnProperty.call(object,property)},writable:true})};';
