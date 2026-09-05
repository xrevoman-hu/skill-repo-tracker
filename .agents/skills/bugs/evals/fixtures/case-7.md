start(id) 设置 current=id,loading=true；await port.load(id) 后无条件 rows=result,loading=false。cancel() 仅 loading=false。先开始 A，再 B；B 先完成；A 后完成。
