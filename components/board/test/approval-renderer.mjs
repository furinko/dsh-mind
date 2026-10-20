import {createRenderer} from './client-harness.mjs';

/**
 * Execute the real root entry and keyed function children with independent hook lifetimes.
 * @param {Function} Component Actual module registration component.
 * @param {object} props Root standard props supplied by the host-contract fixture.
 * @returns {object} Renderer facade; unmount disposes every actual child effect.
 */
export function createApprovalRenderer(Component,props){
  const root=createRenderer(Component,props);const children=new Map();let tree;
  function assemble(flush){
    const used=new Set();
    function visit(node,key='root'){
      if(Array.isArray(node))return node.map((child,i)=>visit(child,key+'/'+(child?.key??i)));
      if(!node||typeof node!=='object'||!node.props)return node;
      if(typeof node.type==='function'){
        const id=key+':'+(node.key??'');used.add(id);let state=children.get(id);
        if(state&&state.type!==node.type){state.renderer.unmount();children.delete(id);state=null;}
        if(!state){const input={...node.props};state={type:node.type,props:input,renderer:createRenderer(node.type,input)};children.set(id,state);}
        else{for(const p of Object.keys(state.props))delete state.props[p];Object.assign(state.props,node.props);state.renderer.render();}
        if(flush)state.renderer.flush();return visit(state.renderer.tree,id+'/out');
      }
      return {...node,props:{...node.props,children:visit(node.props.children,key+'/children')}};
    }
    tree=visit(root.tree);for(const [key,state]of children)if(!used.has(key)){state.renderer.unmount();children.delete(key);}return tree;
  }
  assemble(false);
  return {get tree(){return tree;},render(){root.render();return assemble(false);},flush(){root.flush();return assemble(true);},unmount(){root.unmount();for(const child of children.values())child.renderer.unmount();children.clear();}};
}
